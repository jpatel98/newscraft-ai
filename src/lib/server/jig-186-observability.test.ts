import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	JIG186_ALERT_MIN_SAMPLES,
	JIG186_ALERT_WINDOW_MS,
	JIG186_RUNBOOK,
	JIG186_DASHBOARD_DEFINITIONS,
	PILOT_AVAILABILITY_SLO,
	PILOT_LATENCY_SLO,
	evaluateJig186Alerts
} from './jig-186-observability';

function telemetry(overrides: Record<string, unknown> = {}) {
	return {
		terminal_state: 'complete',
		first_answer_ms: 1_000,
		total_duration_ms: 5_000,
		missing_stages: [],
		failure_class: null,
		...overrides
	} as any;
}

function runSample(observedAt: number, overrides: Record<string, unknown> = {}) {
	return { observedAt, telemetry: telemetry(overrides) };
}

describe('JIG-186 observability definitions', () => {
	it('keeps the pilot values tied to the roadmap and defines every requested dashboard field', () => {
		expect(existsSync(resolve(process.cwd(), JIG186_RUNBOOK.split('#')[0]))).toBe(true);
		expect(PILOT_AVAILABILITY_SLO.requiredReadyRatio).toBe(1);
		expect(PILOT_AVAILABILITY_SLO.source).toBe('ROADMAP.md#phase-a--chat-excellence-now');
		expect(PILOT_LATENCY_SLO).toMatchObject({
			firstTextMs: 3_000,
			totalDurationP50Ms: 12_000,
			totalDurationP90Ms: 25_000,
			source: 'ROADMAP.md#phase-a--chat-excellence-now'
		});
		expect(JIG186_DASHBOARD_DEFINITIONS.map((definition) => definition.metric)).toEqual([
			'queue_wait',
			'first_progress',
			'first_text',
			'total_duration',
			'terminal_state',
			'service_restarts',
			'reconnects',
			'failure_class'
		]);
		expect(JIG186_DASHBOARD_DEFINITIONS.find((definition) => definition.metric === 'service_restarts')).toMatchObject({
			telemetryField: 'health.components.hermes.processInstanceId',
			semantics: expect.stringContaining('process restart')
		});
		expect(JIG186_DASHBOARD_DEFINITIONS.find((definition) => definition.metric === 'reconnects')).toMatchObject({
			telemetryField: 'reconnect_count',
			semantics: expect.stringContaining('not a service restart')
		});
	});

	it('does not alert on one cold readiness probe', () => {
		const alerts = evaluateJig186Alerts(
			{ readiness: [{ observedAt: 9_000, requiredReady: false }], runs: [] },
			9_000
		);

		expect(alerts).toEqual([]);
	});

	it('alerts only after three consecutive required-readiness failures', () => {
		const alerts = evaluateJig186Alerts(
			{
				readiness: [
					{ observedAt: 7_000, requiredReady: false },
					{ observedAt: 8_000, requiredReady: false },
					{ observedAt: 9_000, requiredReady: false }
				],
				runs: []
			},
			9_000
		);

		expect(alerts).toEqual([
			expect.objectContaining({
				kind: 'required_availability',
				sampleCount: JIG186_ALERT_MIN_SAMPLES,
				windowMs: JIG186_ALERT_WINDOW_MS,
				runbook: JIG186_RUNBOOK
			})
		]);
	});

	it('evaluates first text and total duration breaches from complete runs only', () => {
		const alerts = evaluateJig186Alerts(
			{
				readiness: [],
				runs: [
					runSample(7_000, { first_answer_ms: 4_000, total_duration_ms: 10_000 }),
					runSample(8_000, { first_answer_ms: 4_100, total_duration_ms: 13_000 }),
					runSample(9_000, { first_answer_ms: 4_200, total_duration_ms: 30_000 })
				]
			},
			9_000
		);

		expect(alerts.map((item) => item.kind)).toEqual([
			'first_text_latency',
			'total_duration_latency'
		]);
		expect(alerts.every((item) => item.runbook === JIG186_RUNBOOK)).toBe(true);
	});

	it('reports sustained missing stages without treating them as successful latency data', () => {
		const oneMissing = evaluateJig186Alerts(
			{
				readiness: [],
				runs: [runSample(9_000, { first_answer_ms: null, missing_stages: ['first_answer'] })]
			},
			9_000
		);
		expect(oneMissing).toEqual([]);

		const sustainedMissing = evaluateJig186Alerts(
			{
				readiness: [],
				runs: [
					runSample(7_000, { first_answer_ms: null, missing_stages: ['first_answer'] }),
					runSample(8_000, { first_answer_ms: null, missing_stages: ['first_answer'] }),
					runSample(9_000, { first_answer_ms: null, missing_stages: ['first_answer'] })
				]
			},
			9_000
		);

		expect(sustainedMissing).toEqual([
			expect.objectContaining({
				kind: 'telemetry_missing_stage',
				reason: 'telemetry stage first_answer was missing for three consecutive terminal runs',
				runbook: JIG186_RUNBOOK
			})
		]);
	});
});
