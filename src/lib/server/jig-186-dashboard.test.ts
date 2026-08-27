import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	JIG186_MAX_DASHBOARD_SAMPLES,
	buildJig186DashboardSnapshot,
	type Jig186DashboardInput
} from './jig-186-dashboard';

const REPO_ROOT = resolve(process.cwd());
const CLI_PATH = resolve(REPO_ROOT, 'scripts/jig-186-dashboard.mjs');
const MARKER_A = 'a'.repeat(32);
const MARKER_B = 'b'.repeat(32);
const MARKER_C = 'c'.repeat(32);

function health(observedAt: number, httpStatus: number, ok: boolean, processInstanceId: string) {
	return {
		observedAt,
		httpStatus,
		ok,
		state: ok ? 'ready' : 'unavailable',
		components: { hermes: { processInstanceId } }
	};
}

function run(
	observedAt: number,
	overrides: Record<string, unknown> = {}
) {
	return {
		observedAt,
		telemetry: {
			queue_wait_ms: 100,
			first_progress_ms: 200,
			first_answer_ms: 1_000,
			total_duration_ms: 5_000,
			terminal_state: 'complete',
			reconnect_count: 0,
			missing_stages: [],
			failure_class: null,
			...overrides
		}
	};
}

function input(): Jig186DashboardInput {
	return {
		health: [
			health(1_000, 200, true, MARKER_A),
			health(2_000, 200, true, MARKER_A),
			health(3_000, 503, false, MARKER_B),
			health(4_000, 200, true, MARKER_C),
			health(5_000, 503, true, MARKER_C)
		],
		telemetry: [
			run(1_000, { reconnect_count: 1 }),
			run(2_000, {
				queue_wait_ms: 200,
				first_progress_ms: 300,
				first_answer_ms: 2_000,
				total_duration_ms: 7_000,
				reconnect_count: 2
			}),
			run(3_000, {
				terminal_state: 'failed',
				first_answer_ms: null,
				total_duration_ms: null,
				missing_stages: ['first_answer', 'total_duration'],
				failure_class: 'upstream'
			}),
			run(4_000, {
				queue_wait_ms: 300,
				first_progress_ms: 400,
				first_answer_ms: 4_000,
				total_duration_ms: 30_000
			})
		]
	};
}

describe('JIG-186 dashboard snapshot', () => {
	it('computes bounded metrics, true service restarts, and sustained alerts', () => {
		const snapshot = buildJig186DashboardSnapshot(input(), 5_000);

		expect(snapshot.health).toMatchObject({
			sampleCount: 5,
			requiredReadyCount: 3,
			requiredReadyRatio: 0.6,
			statusBodyMismatchCount: 1,
			serviceRestartCount: 2
		});
		expect(snapshot.metrics.queueWait).toMatchObject({ count: 4, p50: 150, p90: 270 });
		expect(snapshot.metrics.firstProgress).toMatchObject({ count: 4, p50: 250, p90: 370 });
		expect(snapshot.metrics.firstText).toMatchObject({ count: 3, p50: 2_000 });
		expect(snapshot.metrics.totalDuration).toMatchObject({ count: 3, p50: 7_000 });
		expect(snapshot.metrics.reconnects).toEqual({ sampleCount: 4, totalCycles: 3 });
		expect(snapshot.terminalStateCounts).toMatchObject({ complete: 3, failed: 1 });
		expect(snapshot.failureClassCounts).toMatchObject({ none: 3, upstream: 1 });
		expect(snapshot.missingStageCounts).toMatchObject({ first_answer: 1, total_duration: 1 });
		expect(snapshot.alerts).toEqual([
			expect.objectContaining({
				kind: 'total_duration_latency',
				runbook: 'docs/release-and-rollback-checklist.md#failure-classification'
			})
		]);
		expect(JSON.stringify(snapshot)).not.toContain('processInstanceId');
	});

	it('ignores malformed records and rejects oversized arrays without copying input', () => {
		const snapshot = buildJig186DashboardSnapshot({
			health: [
				{ observedAt: 'bad', httpStatus: 200, ok: true },
				{ observedAt: 1_000, httpStatus: 200, ok: true, accountId: 'private-account' }
			],
			telemetry: [
				{ observedAt: 1_000, telemetry: { terminal_state: 'complete', prompt: 'private prompt' } },
				run(2_000, {
					answer: 'private answer',
					url: 'https://user:password@example.test',
					queue_wait_ms: 999,
					first_progress_ms: 998,
					missing_stages: ['queue_wait', 'first_progress']
				})
			]
		} as unknown);

		expect(snapshot.health.sampleCount).toBe(1);
		expect(snapshot.metrics.firstText.count).toBe(1);
		expect(snapshot.metrics.queueWait.count).toBe(0);
		expect(snapshot.metrics.firstProgress.count).toBe(0);
		expect(snapshot.missingStageCounts).toMatchObject({ queue_wait: 1, first_progress: 1 });
		expect(JSON.stringify(snapshot)).not.toContain('private');
		expect(JSON.stringify(snapshot)).not.toContain('example.test');
		expect(() =>
			buildJig186DashboardSnapshot({
				health: Array.from({ length: JIG186_MAX_DASHBOARD_SAMPLES + 1 }, () => health(1_000, 200, true, MARKER_A)),
				telemetry: []
			})
		).toThrow('health exceeds its sample bound');
	});

	it('treats out-of-bound durations and reconnect counts as missing data', () => {
		const snapshot = buildJig186DashboardSnapshot({
			health: [],
			telemetry: [
				run(1_000, {
					queue_wait_ms: Number.MAX_SAFE_INTEGER,
					reconnect_count: JIG186_MAX_DASHBOARD_SAMPLES + 1
				})
			]
		});

		expect(snapshot.metrics.queueWait.count).toBe(0);
		expect(snapshot.metrics.reconnects).toEqual({ sampleCount: 0, totalCycles: 0 });
		expect(snapshot.missingStageCounts.queue_wait).toBe(1);
	});

	it('runs through the local CLI with a deterministic time', () => {
		const output = execFileSync(
			process.execPath,
			['--experimental-strip-types', CLI_PATH, '--now', '5000'],
			{ cwd: REPO_ROOT, input: JSON.stringify(input()), encoding: 'utf8' }
		);
		const snapshot = JSON.parse(output) as ReturnType<typeof buildJig186DashboardSnapshot>;
		expect(snapshot.health.serviceRestartCount).toBe(2);
		expect(snapshot.alerts[0]?.runbook).toBe('docs/release-and-rollback-checklist.md#failure-classification');
	});
});
