import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	createTranscript: vi.fn(),
	getTranscript: vi.fn(),
	claimForProcessing: vi.fn(),
	completeTranscript: vi.fn(),
	failTranscript: vi.fn()
}));
vi.mock('$lib/server/db/transcripts', () => db);
vi.mock('$lib/server/db', () => ({ ensureDefaultOrganizationForAccount: vi.fn(async () => 'org-1') }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/environment', () => ({ dev: false }));

import { TranscriptionEngineError, type TranscriptionEngine } from './engine';
import { createTranscriptService, parseNewTranscript } from './service';
import { AudioStorageUnavailableError, type AudioStorage } from './storage';

const stored = (over: Record<string, unknown> = {}) => ({
	id: 't1', status: 'uploading', sourceKind: 'upload', sourceUrl: null, audioKey: 'acct/t1/audio', keyterms: ['TTC'], ...over
});

function fakes() {
	const engine: TranscriptionEngine = {
		name: 'elevenlabs', model: 'scribe_v2', configured: true,
		transcribe: vi.fn(async () => ({ text: 'Hi.', languageCode: 'eng', durationMs: 500, utterances: [{ id: 'u1', speaker: 'speaker_0', start: 0, end: 500, text: 'Hi.', words: [] }] }))
	};
	const storage: AudioStorage = {
		signUpload: vi.fn(async () => 'https://files.test/v1/upload/tok'),
		stat: vi.fn(async () => ({ bytes: 99, contentType: 'audio/mpeg' })),
		signDownload: vi.fn(async () => 'https://files.test/v1/download/tok'),
		remove: vi.fn(async () => {})
	};
	return { engine, storage, service: createTranscriptService({ engine, storage }) };
}

beforeEach(() => {
	vi.resetAllMocks();
	db.failTranscript.mockImplementation(async (_a: string, id: string, code: string, message: string) => stored({ id, status: 'failed', errorCode: code, errorMessage: message }));
	db.completeTranscript.mockImplementation(async () => stored({ status: 'complete' }));
});

describe('parsing new transcription requests', () => {
	it('accepts files, recordings and https links', () => {
		expect(parseNewTranscript({ kind: 'upload', fileName: 'a.mp3', bytes: 10 })).toMatchObject({ kind: 'upload', bytes: 10 });
		expect(parseNewTranscript({ kind: 'link', url: ' https://youtu.be/x ' })).toMatchObject({ kind: 'link', url: 'https://youtu.be/x' });
	});
	it('rejects bad input with plain messages', () => {
		expect(() => parseNewTranscript({ kind: 'link', url: 'http://x.test/a.mp3' })).toThrow(/https/);
		expect(() => parseNewTranscript({ kind: 'link', url: 'not a url' })).toThrow(/https/);
		expect(() => parseNewTranscript({ kind: 'upload', fileName: 'a.mp3', bytes: 2 * 1024 ** 3 })).toThrow(/1 GB/);
		expect(() => parseNewTranscript({ kind: 'upload', fileName: '', bytes: 1 })).toThrow();
		expect(() => parseNewTranscript({ kind: 'other' })).toThrow();
	});
});

describe('transcript service', () => {
	it('creates an upload with a signed URL under the normalized type', async () => {
		const { service, storage } = fakes();
		db.createTranscript.mockResolvedValue(stored());
		const out = await service.create('acct', { kind: 'upload', fileName: 'Memo.m4a', contentType: '', bytes: 10, keyterms: [' TTC ', 'ttc'] });
		expect(db.createTranscript).toHaveBeenCalledWith(expect.objectContaining({ title: 'Memo', contentType: 'audio/mp4', keyterms: ['TTC'], engine: 'elevenlabs' }));
		expect(storage.signUpload).toHaveBeenCalledWith('acct/t1/audio', 'audio/mp4', 10);
		expect(out.upload).toEqual({ url: 'https://files.test/v1/upload/tok', contentType: 'audio/mp4' });
	});

	it('refuses unsupported files before creating anything', async () => {
		const { service } = fakes();
		await expect(service.create('acct', { kind: 'upload', fileName: 'notes.pdf', contentType: 'application/pdf', bytes: 10 })).rejects.toMatchObject({ status: 415 });
		expect(db.createTranscript).not.toHaveBeenCalled();
	});

	it('marks the record failed when storage cannot sign the upload', async () => {
		const { service, storage } = fakes();
		db.createTranscript.mockResolvedValue(stored());
		vi.mocked(storage.signUpload).mockRejectedValue(new AudioStorageUnavailableError());
		await expect(service.create('acct', { kind: 'upload', fileName: 'a.mp3', bytes: 10 })).rejects.toBeInstanceOf(AudioStorageUnavailableError);
		expect(db.failTranscript).toHaveBeenCalledWith('acct', 't1', 'storage_unavailable', expect.any(String));
	});

	it('transcribes an uploaded file from a signed download link', async () => {
		const { service, engine, storage } = fakes();
		db.getTranscript.mockResolvedValue(stored());
		db.claimForProcessing.mockResolvedValue(stored({ status: 'processing' }));
		const out = await service.process('acct', 't1');
		expect(db.claimForProcessing).toHaveBeenCalledWith('acct', 't1', { bytes: 99, contentType: 'audio/mpeg' });
		expect(storage.signDownload).toHaveBeenCalledWith('acct/t1/audio', 900);
		expect(engine.transcribe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'https://files.test/v1/download/tok', keyterms: ['TTC'] }));
		expect(out.status).toBe('complete');
	});

	it('waits for an unfinished upload and leaves a run another request holds', async () => {
		const { service, storage, engine } = fakes();
		db.getTranscript.mockResolvedValue(stored());
		vi.mocked(storage.stat).mockResolvedValueOnce(null);
		await expect(service.process('acct', 't1')).rejects.toMatchObject({ status: 409, code: 'upload_not_ready' });
		db.claimForProcessing.mockResolvedValue(null);
		await service.process('acct', 't1');
		expect(engine.transcribe).not.toHaveBeenCalled();
	});

	it('sends links straight to the engine and records engine failures', async () => {
		const { service, engine } = fakes();
		const link = stored({ sourceKind: 'link', sourceUrl: 'https://youtu.be/x', audioKey: null, status: 'queued' });
		db.getTranscript.mockResolvedValue(link);
		db.claimForProcessing.mockResolvedValue({ ...link, status: 'processing' });
		vi.mocked(engine.transcribe).mockRejectedValue(new TranscriptionEngineError('engine_busy', 'Busy, try again.', true));
		const out = await service.process('acct', 't1');
		expect(engine.transcribe).toHaveBeenCalledWith(expect.objectContaining({ sourceUrl: 'https://youtu.be/x' }));
		expect(out).toMatchObject({ status: 'failed', errorCode: 'engine_busy', errorMessage: 'Busy, try again.' });
	});

	it('fails a recording with no speech', async () => {
		const { service, engine } = fakes();
		db.getTranscript.mockResolvedValue(stored());
		db.claimForProcessing.mockResolvedValue(stored({ status: 'processing' }));
		vi.mocked(engine.transcribe).mockResolvedValue({ text: '', languageCode: null, durationMs: null, utterances: [] });
		expect(await service.process('acct', 't1')).toMatchObject({ status: 'failed', errorCode: 'no_speech' });
	});

	it('returns a finished transcript without running again', async () => {
		const { service, engine } = fakes();
		db.getTranscript.mockResolvedValue(stored({ status: 'complete' }));
		expect(await service.process('acct', 't1')).toMatchObject({ status: 'complete' });
		expect(engine.transcribe).not.toHaveBeenCalled();
		db.getTranscript.mockResolvedValue(null);
		await expect(service.process('acct', 'nope')).rejects.toMatchObject({ status: 404 });
	});
});
