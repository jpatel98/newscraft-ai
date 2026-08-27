/**
 * Reviewable pilot SLO, dashboard, and alert definitions for JIG-186.
 *
 * This module is deliberately pure. It does not write telemetry or contact an
 * observability service. Callers provide the bounded health and durable-run
 * samples that JIG-182 already records.
 */

export const JIG186_RUNBOOK =
	'docs/release-and-rollback-checklist.md#failure-classification' as const;

/**
 * The roadmap gives a quality-gate latency target but no numeric uptime
 * target. The pilot availability target therefore derives from its
 * all-required-gates-must-hold rule: every sampled required-readiness result
 * must be ready during the declared pilot observation window.
 */
export const PILOT_AVAILABILITY_SLO = {
	requiredReadyRatio: 1,
	source: 'ROADMAP.md#phase-a--chat-excellence-now',
	derivation: 'all required quality-gate conditions hold before anything unfreezes'
} as const;

/** Values copied from the roadmap chat quality gate. */
export const PILOT_LATENCY_SLO = {
	firstTextMs: 3_000,
	totalDurationP50Ms: 12_000,
	totalDurationP90Ms: 25_000,
	source: 'ROADMAP.md#phase-a--chat-excellence-now'
} as const;

export const JIG186_ALERT_WINDOW_MS = 5 * 60 * 1_000;
export const JIG186_ALERT_MIN_SAMPLES = 3;
export const JIG186_MAX_EVALUATION_SAMPLES = 1_000;

export interface DashboardDefinition {
	metric: string;
	telemetryField: string;
	unit: 'milliseconds' | 'count' | 'category';
	aggregation: string;
	missingData: string;
	semantics: string;
}

/** Field-level definitions for a dashboard backed by JIG-182 summaries. */
export const JIG186_DASHBOARD_DEFINITIONS: readonly DashboardDefinition[] = [
	{
		metric: 'queue_wait',
		telemetryField: 'queue_wait_ms',
		unit: 'milliseconds',
		aggregation: 'p50 and p90 over runs with a non-null value',
		missingData: 'count missing_stages=queue_wait; do not treat it as zero',
		semantics: 'run.createdAt to run.startedAt'
	},
	{
		metric: 'first_progress',
		telemetryField: 'first_progress_ms',
		unit: 'milliseconds',
		aggregation: 'p50 and p90 over runs with a non-null value',
		missingData: 'count missing_stages=first_progress; do not treat it as zero',
		semantics: 'run.createdAt to the first bounded progress event'
	},
	{
		metric: 'first_text',
		telemetryField: 'first_answer_ms',
		unit: 'milliseconds',
		aggregation: 'p50 and p90 over complete runs with a non-null value',
		missingData: 'count missing_stages=first_answer; do not treat it as slow or fast',
		semantics: 'run.createdAt to the first non-empty answer text event'
	},
	{
		metric: 'total_duration',
		telemetryField: 'total_duration_ms',
		unit: 'milliseconds',
		aggregation: 'p50 and p90 over complete runs with a non-null value',
		missingData: 'count missing_stages=total_duration; exclude from latency quantiles',
		semantics: 'run.createdAt to the saved terminal completion time'
	},
	{
		metric: 'terminal_state',
		telemetryField: 'terminal_state',
		unit: 'category',
		aggregation: 'count by the bounded terminal_state value',
		missingData: 'unknown is a visible category',
		semantics: 'queued, researching, writing, reconnecting, cancel_requested, cancelled, failed, complete, or unknown'
	},
	{
		metric: 'service_restarts',
		telemetryField: 'health.components.hermes.processInstanceId',
		unit: 'count',
		aggregation: 'count transitions between distinct markers in time order',
		missingData: 'missing or invalid markers are unknown; do not infer a restart',
		semantics: 'one Hermes process restart when an authenticated readiness sample changes its opaque per-process marker'
	},
	{
		metric: 'reconnects',
		telemetryField: 'reconnect_count',
		unit: 'count',
		aggregation: 'sum by run and rate per completed run',
		missingData: 'null is not a reconnect; missing summaries are counted separately',
		semantics: 'one browser subscription reconnecting-to-reconnected cycle, counted once; this is not a service restart'
	},
	{
		metric: 'failure_class',
		telemetryField: 'failure_class',
		unit: 'category',
		aggregation: 'count by the bounded failure class',
		missingData: 'null means no failure was recorded',
		semantics: 'cancelled, callback, network, timeout, upstream, lease, protocol, start, or unknown'
	}
] as const;

export interface DurableTelemetrySloSample {
	terminal_state: string;
	first_answer_ms: number | null;
	total_duration_ms: number | null;
	missing_stages: readonly string[];
	failure_class: string | null;
}

export interface Jig186ReadinessSample {
	observedAt: number;
	requiredReady: boolean;
}

export interface Jig186RunSample {
	observedAt: number;
	telemetry: DurableTelemetrySloSample;
}

export interface Jig186AlertInput {
	readiness: readonly Jig186ReadinessSample[];
	runs: readonly Jig186RunSample[];
}

export type Jig186AlertKind =
	| 'required_availability'
	| 'first_text_latency'
	| 'total_duration_latency'
	| 'telemetry_missing_stage';

export interface Jig186Alert {
	kind: Jig186AlertKind;
	severity: 'warning' | 'critical';
	windowMs: number;
	sampleCount: number;
	reason: string;
	runbook: typeof JIG186_RUNBOOK;
}

const TERMINAL_STATES = new Set(['cancelled', 'failed', 'complete']);
const MISSING_STAGE_ALERTS = ['first_answer', 'total_duration'] as const;

function inWindow<T extends { observedAt: number }>(
	values: readonly T[],
	now: number
): T[] {
	return values
		.filter(
			(value) =>
				Number.isFinite(value.observedAt) &&
				value.observedAt <= now &&
				value.observedAt >= now - JIG186_ALERT_WINDOW_MS
		)
		.sort((a, b) => a.observedAt - b.observedAt)
		.slice(-JIG186_MAX_EVALUATION_SAMPLES);
}

function quantile(values: readonly number[], fraction: number): number {
	const ordered = [...values].sort((a, b) => a - b);
	if (!ordered.length) return Number.NaN;
	const position = (ordered.length - 1) * fraction;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return ordered[lower];
	return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function alert(
	kind: Jig186AlertKind,
	severity: Jig186Alert['severity'],
	sampleCount: number,
	reason: string
): Jig186Alert {
	return {
		kind,
		severity,
		windowMs: JIG186_ALERT_WINDOW_MS,
		sampleCount,
		reason,
		runbook: JIG186_RUNBOOK
	};
}

/**
 * Evaluate only sustained conditions. One cold probe or one incomplete run
 * cannot create an alert. No trace, account, tenant, prompt, answer, URL, or
 * provider payload is accepted by this interface or returned by this function.
 */
export function evaluateJig186Alerts(input: Jig186AlertInput, now = Date.now()): Jig186Alert[] {
	const alerts: Jig186Alert[] = [];
	const readiness = inWindow(input.readiness, now);
	const latestReadiness = readiness.slice(-JIG186_ALERT_MIN_SAMPLES);
	if (
		latestReadiness.length === JIG186_ALERT_MIN_SAMPLES &&
		latestReadiness.every((sample) => sample.requiredReady === false)
	) {
		alerts.push(
			alert(
				'required_availability',
				'critical',
				latestReadiness.length,
				'required readiness failed for three consecutive samples'
			)
		);
	}

	const runs = inWindow(input.runs, now);
	const terminalRuns = runs.filter((sample) => TERMINAL_STATES.has(sample.telemetry.terminal_state));
	const completeRuns = terminalRuns.filter((sample) => sample.telemetry.terminal_state === 'complete');
	const validFirstText = completeRuns.filter(
		(sample) =>
			typeof sample.telemetry.first_answer_ms === 'number' &&
			Number.isFinite(sample.telemetry.first_answer_ms) &&
			!sample.telemetry.missing_stages.includes('first_answer')
	);
	const latestFirstText = validFirstText.slice(-JIG186_ALERT_MIN_SAMPLES);
	if (
		latestFirstText.length === JIG186_ALERT_MIN_SAMPLES &&
		latestFirstText.every((sample) => sample.telemetry.first_answer_ms! > PILOT_LATENCY_SLO.firstTextMs)
	) {
		alerts.push(
			alert(
				'first_text_latency',
				'warning',
				latestFirstText.length,
				'first text exceeded the pilot latency SLO for three consecutive complete runs'
			)
		);
	}

	const validTotalDuration = completeRuns
		.filter(
			(sample) =>
				typeof sample.telemetry.total_duration_ms === 'number' &&
				Number.isFinite(sample.telemetry.total_duration_ms) &&
				!sample.telemetry.missing_stages.includes('total_duration')
		)
		.map((sample) => sample.telemetry.total_duration_ms!);
	if (validTotalDuration.length >= JIG186_ALERT_MIN_SAMPLES) {
		const p50 = quantile(validTotalDuration, 0.5);
		const p90 = quantile(validTotalDuration, 0.9);
		if (p50 > PILOT_LATENCY_SLO.totalDurationP50Ms || p90 > PILOT_LATENCY_SLO.totalDurationP90Ms) {
			alerts.push(
				alert(
					'total_duration_latency',
					'warning',
					validTotalDuration.length,
					'total duration breached the pilot p50 or p90 latency SLO'
				)
			);
		}
	}

	for (const stage of MISSING_STAGE_ALERTS) {
		const latestTerminal = terminalRuns.slice(-JIG186_ALERT_MIN_SAMPLES);
		if (
			latestTerminal.length === JIG186_ALERT_MIN_SAMPLES &&
			latestTerminal.every((sample) => sample.telemetry.missing_stages.includes(stage))
		) {
			alerts.push(
				alert(
					'telemetry_missing_stage',
					'warning',
					latestTerminal.length,
					`telemetry stage ${stage} was missing for three consecutive terminal runs`
				)
			);
		}
	}

	return alerts;
}
