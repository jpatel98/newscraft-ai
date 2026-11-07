import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getTranscript: vi.fn(),
	updateTranscript: vi.fn(),
	process: vi.fn(),
	checkRateLimit: vi.fn()
}));
vi.mock('$lib/server/db/transcripts', () => ({ ...mocks, publicTranscript: (value: unknown) => value }));
vi.mock('$lib/server/transcripts/service', () => ({
	getTranscriptService: () => ({ process: mocks.process }),
	TranscriptRequestError: class extends Error {}
}));
vi.mock('$lib/server/transcripts/storage', () => ({
	getAudioStorage: vi.fn(),
	AudioStorageUnavailableError: class extends Error {}
}));
vi.mock('$lib/server/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }));

import { POST } from './[id]/process/+server';
import { PATCH } from './[id]/+server';

beforeEach(() => {
	vi.resetAllMocks();
	mocks.checkRateLimit.mockReturnValue({ allowed: true });
	mocks.process.mockResolvedValue({ id: 'transcript', status: 'complete' });
});

describe('transcription routes', () => {
	it('requires an authenticated account before attempting processing', async () => {
		await expect(POST({ locals: { user: null }, params: { id: 'transcript' } } as never)).rejects.toMatchObject({ status: 401 });
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(mocks.process).not.toHaveBeenCalled();
	});

	it('rate limits retries per account before calling the engine service', async () => {
		mocks.checkRateLimit.mockReturnValue({ allowed: false });
		await expect(POST({ locals: { user: { id: 'owner' } }, params: { id: 'transcript' } } as never)).rejects.toMatchObject({ status: 429 });
		expect(mocks.checkRateLimit).toHaveBeenCalledWith('transcribe-process:owner', { limit: 30, windowMs: 3_600_000 });
		expect(mocks.process).not.toHaveBeenCalled();
	});

	it('passes only the authenticated owner to the processing service', async () => {
		const response = await POST({ locals: { user: { id: 'owner' } }, params: { id: 'transcript' } } as never);
		expect(response.status).toBe(200);
		expect(mocks.process).toHaveBeenCalledWith('owner', 'transcript');
	});

	it.each([null, [], 4, 'bad'])('rejects non-object edit payload %j before a database read', async (body) => {
		const request = new Request('https://test.invalid/api/transcriptions/transcript', { method: 'PATCH', body: JSON.stringify(body) });
		await expect(PATCH({ locals: { user: { id: 'owner' } }, params: { id: 'transcript' }, request } as never)).rejects.toMatchObject({ status: 400 });
		expect(mocks.getTranscript).not.toHaveBeenCalled();
		expect(mocks.updateTranscript).not.toHaveBeenCalled();
	});
});
