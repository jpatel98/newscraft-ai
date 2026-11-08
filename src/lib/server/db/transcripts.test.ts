import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('./index', () => mocks);
import { claimForProcessing, completeTranscript, failTranscript, getTranscript, publicTranscript } from './transcripts';

const query = () => {
	const [parts, ...params] = mocks.sql.mock.calls[0];
	return { text: (parts as TemplateStringsArray).join('?').replace(/\s+/g, ' '), params };
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sql.mockResolvedValue([]);
});

describe('transcript processing compare-and-swap', () => {
	it('returns the claim identity privately and excludes it from browser responses', async () => {
		mocks.sql.mockResolvedValue([{ id: 'transcript', processing_started_at: '1234', audio_key: 'owner/audio', status: 'processing' }]);
		const row = await getTranscript('owner', 'transcript');
		expect(row!.processingStartedAt).toBe(1234);
		expect(publicTranscript(row!)).not.toHaveProperty('processingStartedAt');
		expect(publicTranscript(row!)).not.toHaveProperty('audioKey');
	});

	it('advances processing identity even when two retries start in the same millisecond', async () => {
		await claimForProcessing('owner', 'transcript');
		expect(query().text).toContain('processing_started_at = GREATEST(?, COALESCE(processing_started_at + 1, ?))');
		expect(query().text).toContain('WHERE id = ? AND account_id = ?');
	});

	it('requires the active account-owned claim to complete', async () => {
		await expect(completeTranscript('owner', 'transcript', { text: 'result', utterances: [], languageCode: null, durationMs: 2 }, 1234)).resolves.toBeNull();
		expect(query().text).toContain("WHERE id = ? AND account_id = ? AND status = 'processing' AND processing_started_at = ?");
		expect(query().params.slice(-3)).toEqual(['transcript', 'owner', 1234]);
	});

	it.each([null, 1234])('allows failure only for the supplied processing claim or an unclaimed upload (%s)', async (token) => {
		await expect(failTranscript('owner', 'transcript', 'failed', 'Safe message', token)).resolves.toBeNull();
		expect(query().text).toContain("WHERE id = ? AND account_id = ? AND ((status = 'processing' AND processing_started_at = ?) OR (status = 'uploading' AND processing_started_at IS NULL AND ?::bigint IS NULL))");
		expect(query().params.slice(-4)).toEqual(['transcript', 'owner', token, token]);
	});
});
