import { describe, expect, it, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({ env: {} }));
import { cleanKeyterms, createElevenLabsEngine, utterancesFromElevenLabsWords } from './engine';

const w = (text: string, start: number, end: number, speaker = 'speaker_0') => ({ text, start, end, type: 'word', speaker_id: speaker });
const sp = (speaker = 'speaker_0') => ({ text: ' ', start: 0, end: 0, type: 'spacing', speaker_id: speaker });

describe('ElevenLabs words to speaker turns', () => {
	it('groups by speaker and pause, keeps spacing and drops audio events', () => {
		const turns = utterancesFromElevenLabsWords([
			w('Thanks', 0.1, 0.4), sp(), w('for', 0.45, 0.6), sp(), w('coming.', 0.62, 1.0),
			{ text: '(laughter)', start: 1.0, end: 1.5, type: 'audio_event', speaker_id: 'speaker_0' },
			w('Happy', 1.2, 1.5, 'speaker_1'), sp('speaker_1'), w('to.', 1.55, 1.8, 'speaker_1'),
			w('Next', 4.5, 4.8, 'speaker_1')
		]);
		expect(turns.map((t) => [t.speaker, t.text, t.start, t.end])).toEqual([
			['speaker_0', 'Thanks for coming.', 100, 1000],
			['speaker_1', 'Happy to.', 1200, 1800],
			['speaker_1', 'Next', 4500, 4800]
		]);
		expect(turns[0].words).toHaveLength(3);
		expect(turns.map((t) => t.id)).toEqual(['u1', 'u2', 'u3']);
	});

	it('tolerates missing or junk input', () => {
		expect(utterancesFromElevenLabsWords(undefined)).toEqual([]);
		expect(utterancesFromElevenLabsWords([{ text: 'Hi', start: 'x' }])).toMatchObject([{ speaker: 'speaker_0', start: 0, text: 'Hi' }]);
	});
});

describe('keyterms', () => {
	it('trims, dedupes case-insensitively and caps the list', () => {
		expect(cleanKeyterms([' Olivia  Chow ', 'olivia chow', 'TTC', 4, ''])).toEqual(['Olivia Chow', 'TTC']);
		expect(cleanKeyterms(Array.from({ length: 80 }, (_, i) => `t${i}`))).toHaveLength(50);
		expect(cleanKeyterms('nope')).toEqual([]);
	});
});

describe('ElevenLabs engine', () => {
	it('sends a diarized word-level request with the source URL and keyterms', async () => {
		const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) =>
			Response.json({ text: 'Hello there.', language_code: 'eng', words: [w('Hello', 0, 0.3), sp(), w('there.', 0.35, 0.8)] })
		);
		const engine = createElevenLabsEngine({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
		const result = await engine.transcribe({ sourceUrl: 'https://files.example.test/v1/download/t', keyterms: ['Metrolinx', 'TTC'] });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).toBe('https://api.elevenlabs.io/v1/speech-to-text');
		expect((init!.headers as Record<string, string>)['xi-api-key']).toBe('k');
		const form = init!.body as FormData;
		expect(form.get('model_id')).toBe('scribe_v2');
		expect(form.get('source_url')).toBe('https://files.example.test/v1/download/t');
		expect(form.get('diarize')).toBe('true');
		expect(form.get('timestamps_granularity')).toBe('word');
		expect(form.getAll('keyterms')).toEqual(['Metrolinx', 'TTC']);
		expect(result).toMatchObject({ text: 'Hello there.', languageCode: 'eng', durationMs: 800 });
		expect(result.utterances).toHaveLength(1);
	});

	it('reports a missing key and maps provider errors to plain messages', async () => {
		await expect(createElevenLabsEngine({ apiKey: '' }).transcribe({ sourceUrl: 'https://x.test/a' })).rejects.toMatchObject({ code: 'engine_not_configured' });
		const engineFor = (status: number) => createElevenLabsEngine({ apiKey: 'k', fetchImpl: (async () => new Response('{}', { status })) as unknown as typeof fetch });
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(engineFor(401).transcribe({ sourceUrl: 'https://x.test/a' })).rejects.toMatchObject({ code: 'engine_auth_failed', retryable: false });
		await expect(engineFor(429).transcribe({ sourceUrl: 'https://x.test/a' })).rejects.toMatchObject({ code: 'engine_busy', retryable: true });
		await expect(engineFor(422).transcribe({ sourceUrl: 'https://x.test/a' })).rejects.toMatchObject({ code: 'media_unreadable' });
		await expect(engineFor(500).transcribe({ sourceUrl: 'https://x.test/a' })).rejects.toMatchObject({ code: 'engine_failed' });
	});

	it('turns an aborted request into a timeout', async () => {
		const fetchImpl = (async () => {
			throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		}) as unknown as typeof fetch;
		await expect(createElevenLabsEngine({ apiKey: 'k', fetchImpl }).transcribe({ sourceUrl: 'https://x.test/a' })).rejects.toMatchObject({ code: 'engine_timeout' });
	});
});
