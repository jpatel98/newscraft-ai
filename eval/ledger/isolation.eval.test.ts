import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../../vitest.eval.config';
import { Cassette, recordingUrl } from './replay';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('offline ledger evaluation', () => {
	it('opts into live recording only through the explicitly named package command', () => {
		const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
		expect(scripts['eval:ledger:record']).toBe('test -n "$LEDGER_EVAL_JUDGE_URL" && LEDGER_EVAL_RECORD=1 vitest run --config vitest.eval.config.ts');
		expect(scripts['eval:ledger']).toBe('vitest run --config vitest.eval.config.ts');
		expect(scripts.test).not.toContain('LEDGER_EVAL_RECORD=1');
	});

	it('disables dotenv loading and does not initialize the SvelteKit environment', () => {
		expect(config.envDir).toBe(false);
		expect(config.plugins ?? []).toEqual([]);
	});

	it.each([undefined, '', '0', 'true'])('does not enable recording with LEDGER_EVAL_RECORD=%s', (mode) => {
		vi.stubEnv('LEDGER_EVAL_RECORD', mode);
		vi.stubEnv('LEDGER_EVAL_JUDGE_URL', 'https://worker.invalid');
		vi.stubEnv('LEDGER_EVAL_COPY_URL', 'https://worker.invalid');
		const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
		vi.stubGlobal('fetch', fetch);
		expect(recordingUrl('JUDGE')).toBeUndefined();
		expect(recordingUrl('COPY')).toBeUndefined();
		const cassette = new Cassette('/dev/null/none');
		expect(() => cassette.recording('https://worker.invalid', 'synthetic-token')).toThrow('LEDGER_EVAL_RECORD=1');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('only calls the injected recording transport after an explicit opt-in', async () => {
		vi.stubEnv('LEDGER_EVAL_RECORD', '1');
		vi.stubEnv('LEDGER_EVAL_JUDGE_URL', 'https://worker.invalid');
		vi.stubEnv('LEDGER_EVAL_COPY_URL', 'https://copy.invalid');
		const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ verdicts: [{ id: 'p0', verdict: 'same' }] }) });
		vi.stubGlobal('fetch', fetch);
		expect(recordingUrl('JUDGE')).toBe('https://worker.invalid');
		expect(recordingUrl('COPY')).toBe('https://copy.invalid');
		const cassette = new Cassette('/dev/null/none');
		const judge = cassette.recording(recordingUrl('JUDGE')!, 'synthetic-token');
		const verdicts = await judge([{ id: 'pair', a: 'First wording', b: 'Second wording' }]);
		expect(verdicts?.get('pair')).toBe('same');
		expect(fetch).toHaveBeenCalledTimes(1);
		await judge([{ id: 'repeated', a: 'First wording', b: 'Second wording' }]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
