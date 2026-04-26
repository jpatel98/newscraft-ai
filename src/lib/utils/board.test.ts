import { describe, expect, it } from 'vitest';
import { buildBoardData, isSafeChildPath, parseCronMarkdown } from './board';
import type { BoardPost, HermesJob } from '$lib/types';

const SAMPLE = `# Cron Job: NEWSWATCH

**Job ID:** 4c84f5c519d7
**Run Time:** 2026-04-26 17:38:23
**Schedule:** every 180m

## Prompt

This metadata should stay out of the board body.

## Response

# Newswatch Report

- Lead item
- Second item
`;

function job(overrides: Partial<HermesJob> = {}): HermesJob {
	return {
		id: '4c84f5c519d7',
		name: 'NEWSWATCH',
		scheduleDisplay: 'every 180m',
		state: 'scheduled',
		enabled: true,
		nextRunAt: null,
		lastRunAt: '2026-04-26T17:38:23.000Z',
		lastStatus: 'ok',
		lastError: null,
		lastDeliveryError: null,
		deliver: 'telegram',
		...overrides
	};
}

function post(overrides: Partial<BoardPost> = {}): BoardPost {
	return {
		id: '4c84f5c519d7:2026-04-26_17-38-23.md',
		jobId: '4c84f5c519d7',
		channel: 'NEWSWATCH',
		channelSlug: '',
		runTime: '2026-04-26T17:38:23.000Z',
		schedule: 'every 180m',
		filename: '2026-04-26_17-38-23.md',
		responseMarkdown: '# Newswatch Report\n\nLead item',
		preview: 'Newswatch Report Lead item',
		archived: false,
		...overrides
	};
}

describe('board utilities', () => {
	it('parses cron markdown into metadata and response body only', () => {
		const parsed = parseCronMarkdown(SAMPLE, 'fallback');
		expect(parsed.jobId).toBe('4c84f5c519d7');
		expect(parsed.channel).toBe('NEWSWATCH');
		expect(parsed.runTime).toBe('2026-04-26T17:38:23.000Z');
		expect(parsed.schedule).toBe('every 180m');
		expect(parsed.responseMarkdown).toContain('# Newswatch Report');
		expect(parsed.responseMarkdown).not.toContain('## Prompt');
		expect(parsed.preview).toContain('Lead item');
	});

	it('groups active jobs and orphaned outputs into channels', () => {
		const board = buildBoardData(
			[
				post(),
				post({
					id: 'ae0ac6645d2a:2026-04-25_17-48-59.md',
					jobId: 'ae0ac6645d2a',
					channel: 'Canadian news digest scan',
					runTime: '2026-04-25T17:48:59.000Z',
					filename: '2026-04-25_17-48-59.md'
				})
			],
			[job()]
		);

		const active = board.channels.find((channel) => channel.name === 'NEWSWATCH');
		const archived = board.channels.find((channel) => channel.name === 'Canadian news digest scan');
		expect(active?.active).toBe(true);
		expect(active?.postCount).toBe(1);
		expect(archived?.active).toBe(false);
		expect(archived?.state).toBe('archived');
		expect(board.posts.find((p) => p.jobId === 'ae0ac6645d2a')?.archived).toBe(true);
	});

	it('rejects traversal outside the cron output root', () => {
		expect(isSafeChildPath('/home/me/.hermes/cron/output', '/home/me/.hermes/cron/output/job/a.md')).toBe(
			true
		);
		expect(isSafeChildPath('/home/me/.hermes/cron/output', '/home/me/.hermes/cron/output/../jobs.json')).toBe(
			false
		);
		expect(isSafeChildPath('/home/me/.hermes/cron/output', '/home/me/.hermes/secret.md')).toBe(false);
	});
});
