import { describe, expect, it } from 'vitest';
import { detectRunRequestOutcome } from './run-poll';

describe('detectRunRequestOutcome', () => {
	it('detects new post arrival', () => {
		expect(
			detectRunRequestOutcome({
				previousLatestPostId: 'old',
				currentLatestPostId: 'new',
				previousLastRunAt: null,
				currentLastRunAt: null,
				currentLastStatus: null,
				currentLastError: null
			})
		).toEqual({ kind: 'new-post' });
	});

	it('detects finished run when lastRunAt advances', () => {
		expect(
			detectRunRequestOutcome({
				previousLatestPostId: 'same',
				currentLatestPostId: 'same',
				previousLastRunAt: '2026-04-27T16:00:00.000Z',
				currentLastRunAt: '2026-04-27T16:05:00.000Z',
				currentLastStatus: 'ok',
				currentLastError: null
			})
		).toEqual({ kind: 'run-finished', failed: false });
	});

	it('treats advanced failed status as failed', () => {
		expect(
			detectRunRequestOutcome({
				previousLatestPostId: 'same',
				currentLatestPostId: 'same',
				previousLastRunAt: '2026-04-27T16:00:00.000Z',
				currentLastRunAt: '2026-04-27T16:05:00.000Z',
				currentLastStatus: 'failed',
				currentLastError: null
			})
		).toEqual({ kind: 'run-finished', failed: true });
	});

	it('treats advanced run with new error as failed', () => {
		expect(
			detectRunRequestOutcome({
				previousLatestPostId: 'same',
				currentLatestPostId: 'same',
				previousLastRunAt: '2026-04-27T16:00:00.000Z',
				currentLastRunAt: '2026-04-27T16:05:00.000Z',
				currentLastStatus: 'ok',
				currentLastError: 'Tool crashed'
			})
		).toEqual({ kind: 'run-finished', failed: true });
	});

	it('stays pending when nothing changed', () => {
		expect(
			detectRunRequestOutcome({
				previousLatestPostId: 'same',
				currentLatestPostId: 'same',
				previousLastRunAt: '2026-04-27T16:00:00.000Z',
				currentLastRunAt: '2026-04-27T16:00:00.000Z',
				currentLastStatus: 'ok',
				currentLastError: null
			})
		).toEqual({ kind: 'pending' });
	});
});
