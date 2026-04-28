import { describe, expect, it } from 'vitest';
import { buildBoardData, isActiveRun, isSafeChildPath, parseCronMarkdown } from './board';
import type { BoardPost, HermesJob, HermesRun } from '$lib/types';

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
		prompt: 'Scan the news',
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

function run(overrides: Partial<HermesRun> = {}): HermesRun {
	return {
		id: 'run-1',
		jobId: '4c84f5c519d7',
		jobName: 'NEWSWATCH',
		status: 'running',
		queuedAt: '2026-04-26T17:59:00.000Z',
		startedAt: '2026-04-26T18:00:00.000Z',
		completedAt: null,
		updatedAt: '2026-04-26T18:01:00.000Z',
		elapsedMs: 60_000,
		lastError: null,
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

	it('preserves safe markdown file display metadata', () => {
		const board = buildBoardData(
			[
				post({
					filePathDisplay: '4c84f5c519d7/2026-04-26_17-38-23.md'
				})
			],
			[job()]
		);

		expect(board.posts[0]?.kind).toBe('report');
		expect(board.posts[0]?.filePathDisplay).toBe('4c84f5c519d7/2026-04-26_17-38-23.md');
	});

	it('merges active runs into live job channels', () => {
		const board = buildBoardData([post()], [job()], [
			run({
				id: 'run-complete',
				status: 'completed',
				startedAt: '2026-04-26T17:38:00.000Z',
				completedAt: '2026-04-26T17:39:00.000Z'
			}),
			run()
		]);

		const active = board.channels.find((channel) => channel.name === 'NEWSWATCH');
		expect(active?.state).toBe('running');
		expect(active?.activeRun?.id).toBe('run-1');
		expect(active?.recentRun?.id).toBe('run-1');
		expect(active?.latestRunAt).toBe('2026-04-26T18:01:00.000Z');
		expect(board.runs?.map((boardRun) => boardRun.id)).toEqual(['run-1', 'run-complete']);
		expect(isActiveRun(run({ status: 'queued' }))).toBe(true);
		expect(isActiveRun(run({ status: 'failed' }))).toBe(false);
	});

	it('adds failed run events when no markdown report was saved', () => {
		const board = buildBoardData([], [job()], [
			run({
				id: 'run-failed',
				status: 'failed',
				startedAt: '2026-04-26T18:00:00.000Z',
				completedAt: '2026-04-26T18:01:00.000Z',
				lastError: 'source timeout'
			})
		]);

		const event = board.posts.find((p) => p.id === 'run:run-failed');
		expect(event?.kind).toBe('run');
		expect(event?.runStatus).toBe('failed');
		expect(event?.lastError).toBe('source timeout');
		expect(event?.preview).toContain('Failed run');
		expect(board.channels.find((channel) => channel.name === 'NEWSWATCH')?.postCount).toBe(1);
	});

	it('preserves archived channels when recent runs exist without a live job', () => {
		const board = buildBoardData(
			[
				post({
					jobId: 'old-job',
					channel: 'Former digest',
					runTime: '2026-04-25T17:48:59.000Z',
					filename: '2026-04-25_17-48-59.md'
				})
			],
			[],
			[
				run({
					id: 'old-run',
					jobId: 'old-job',
					jobName: 'Former digest',
					status: 'completed',
					completedAt: '2026-04-25T17:49:30.000Z'
				})
			]
		);

		const archived = board.channels.find((channel) => channel.name === 'Former digest');
		expect(archived?.active).toBe(false);
		expect(archived?.state).toBe('archived');
		expect(archived?.activeRun).toBeNull();
		expect(archived?.recentRun?.id).toBe('old-run');
		expect(board.posts[0]?.archived).toBe(true);
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
