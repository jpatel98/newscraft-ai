export interface DetectRunRequestOutcomeInput {
	previousLatestPostId: string;
	currentLatestPostId: string;
	previousLastRunAt: string | null;
	currentLastRunAt: string | null;
	currentLastStatus: string | null;
	currentLastError: string | null;
}

export type RunRequestOutcome =
	| { kind: 'new-post' }
	| { kind: 'run-finished'; failed: boolean }
	| { kind: 'pending' };

const FAILURE_STATUSES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);

function parseTime(value: string | null): number {
	if (!value) return Number.NaN;
	return Date.parse(value);
}

function isNewerRun(previousLastRunAt: string | null, currentLastRunAt: string | null): boolean {
	if (!currentLastRunAt) return false;
	if (!previousLastRunAt) return true;
	if (currentLastRunAt === previousLastRunAt) return false;

	const previousMs = parseTime(previousLastRunAt);
	const currentMs = parseTime(currentLastRunAt);
	if (Number.isFinite(previousMs) && Number.isFinite(currentMs)) return currentMs > previousMs;
	return true;
}

export function detectRunRequestOutcome(input: DetectRunRequestOutcomeInput): RunRequestOutcome {
	if (input.currentLatestPostId && input.currentLatestPostId !== input.previousLatestPostId) {
		return { kind: 'new-post' };
	}

	if (isNewerRun(input.previousLastRunAt, input.currentLastRunAt)) {
		const status = (input.currentLastStatus || '').toLowerCase();
		const failed = FAILURE_STATUSES.has(status) || Boolean(input.currentLastError);
		return { kind: 'run-finished', failed };
	}

	return { kind: 'pending' };
}
