import {
	JIG186_RUNBOOK,
	evaluateJig186Alerts,
	type DurableTelemetrySloSample,
	type Jig186Alert,
	type Jig186ReadinessSample,
	type Jig186RunSample
} from './jig-186-observability.ts';

export const JIG186_MAX_DASHBOARD_SAMPLES = 10_000;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RECONNECT_CYCLES = JIG186_MAX_DASHBOARD_SAMPLES;

const TERMINAL_STATES = [
	'queued',
	'researching',
	'writing',
	'reconnecting',
	'cancel_requested',
	'cancelled',
	'failed',
	'complete',
	'unknown'
] as const;
const FAILURE_CLASSES = [
	'none',
	'cancelled',
	'callback',
	'network',
	'timeout',
	'upstream',
	'lease',
	'protocol',
	'start',
	'unknown'
] as const;
const MISSING_STAGES = ['queue_wait', 'first_progress', 'first_answer', 'total_duration'] as const;
const MAX_MISSING_STAGES = 32;
const PROCESS_INSTANCE_ID_RE = /^[a-f0-9]{32}$/;

type TerminalState = (typeof TERMINAL_STATES)[number];
type FailureClass = (typeof FAILURE_CLASSES)[number];
type MissingStage = (typeof MISSING_STAGES)[number];

export interface Jig186RedactedHealthSample {
	observedAt: number;
	httpStatus: number;
	ok: boolean;
	state?: string;
	components?: { hermes?: { processInstanceId?: string | null } };
	gateway?: { processInstanceId?: string | null };
}

export interface Jig186DurableTelemetrySample {
	observedAt: number;
	telemetry: DurableTelemetrySloSample & {
		queue_wait_ms: number | null;
		first_progress_ms: number | null;
		reconnect_count: number | null;
	};
}

export interface Jig186DashboardInput {
	health: readonly Jig186RedactedHealthSample[];
	telemetry: readonly Jig186DurableTelemetrySample[];
}

export interface Jig186QuantileSummary {
	count: number;
	p50: number | null;
	p90: number | null;
}

export interface Jig186ReconnectSummary {
	sampleCount: number;
	totalCycles: number;
}

export interface Jig186DashboardSnapshot {
	health: {
		sampleCount: number;
		requiredReadyCount: number;
		requiredReadyRatio: number | null;
		statusBodyMismatchCount: number;
		serviceRestartCount: number;
	};
	metrics: {
		queueWait: Jig186QuantileSummary;
		firstProgress: Jig186QuantileSummary;
		firstText: Jig186QuantileSummary;
		totalDuration: Jig186QuantileSummary;
		reconnects: Jig186ReconnectSummary;
	};
	terminalStateCounts: Record<TerminalState, number>;
	failureClassCounts: Record<FailureClass, number>;
	missingStageCounts: Record<MissingStage, number>;
	alerts: Jig186Alert[];
	runbook: typeof JIG186_RUNBOOK;
}

interface NormalizedHealthSample extends Jig186ReadinessSample {
	processInstanceId: string | null;
	statusBodyMismatch: boolean;
}

interface NormalizedTelemetrySample extends Jig186RunSample {
	telemetry: DurableTelemetrySloSample & {
		queue_wait_ms: number | null;
		first_progress_ms: number | null;
		reconnect_count: number | null;
	};
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function boundedArray(value: unknown, name: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`JIG-186 ${name} must be an array`);
	if (value.length > JIG186_MAX_DASHBOARD_SAMPLES) {
		throw new RangeError(`JIG-186 ${name} exceeds its sample bound`);
	}
	return value;
}

function timestamp(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function duration(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS
		? value
		: null;
}

function reconnectCycles(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECONNECT_CYCLES
		? value
		: null;
}

function processInstanceId(value: unknown): string | null {
	return typeof value === 'string' && PROCESS_INSTANCE_ID_RE.test(value) ? value : null;
}

function category<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value)
		? (value as T[number])
		: ('unknown' as T[number]);
}

function countRecord<T extends readonly string[]>(keys: T): Record<T[number], number> {
	return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function normalizeHealth(value: unknown): NormalizedHealthSample | null {
	const record = objectValue(value);
	const observedAt = timestamp(record?.observedAt);
	const httpStatus = record?.httpStatus;
	if (
		!record ||
		observedAt == null ||
		typeof httpStatus !== 'number' ||
		!Number.isInteger(httpStatus) ||
		httpStatus < 100 ||
		httpStatus > 599 ||
		typeof record.ok !== 'boolean'
	) {
		return null;
	}
	const components = objectValue(record.components);
	const hermes = objectValue(components?.hermes);
	const gateway = objectValue(record.gateway);
	const marker = processInstanceId(hermes?.processInstanceId) || processInstanceId(gateway?.processInstanceId);
	const bodyReady = record.ok === true;
	const httpReady = httpStatus === 200;
	return {
		observedAt,
		requiredReady: httpReady && bodyReady,
		processInstanceId: marker,
		statusBodyMismatch: httpReady !== bodyReady
	};
}

function normalizeMissingStages(value: unknown): Set<MissingStage> | null {
	if (!Array.isArray(value) || value.length > MAX_MISSING_STAGES) return null;
	const missing = new Set<MissingStage>();
	for (const stage of value) {
		if ((MISSING_STAGES as readonly string[]).includes(stage as string)) {
			missing.add(stage as MissingStage);
		}
	}
	return missing;
}

function normalizeTelemetry(value: unknown): NormalizedTelemetrySample | null {
	const record = objectValue(value);
	const telemetry = objectValue(record?.telemetry);
	const observedAt = timestamp(record?.observedAt);
	const missing = normalizeMissingStages(telemetry?.missing_stages);
	if (!telemetry || observedAt == null || typeof telemetry.terminal_state !== 'string' || !missing) {
		return null;
	}

	const queueWait = duration(telemetry.queue_wait_ms);
	const firstProgress = duration(telemetry.first_progress_ms);
	const firstText = duration(telemetry.first_answer_ms);
	const totalDuration = duration(telemetry.total_duration_ms);
	if (queueWait == null) missing.add('queue_wait');
	if (firstProgress == null) missing.add('first_progress');
	if (firstText == null) missing.add('first_answer');
	if (totalDuration == null) missing.add('total_duration');

	const rawFailure = telemetry.failure_class;
	const failureClass: FailureClass | null =
		rawFailure == null
			? null
			: typeof rawFailure === 'string'
				? category(rawFailure, FAILURE_CLASSES)
				: null;
	const reconnectCount = reconnectCycles(telemetry.reconnect_count);
	return {
		observedAt,
		telemetry: {
			terminal_state: category(telemetry.terminal_state, TERMINAL_STATES),
			queue_wait_ms: queueWait,
			first_progress_ms: firstProgress,
			first_answer_ms: firstText,
			total_duration_ms: totalDuration,
			reconnect_count: reconnectCount,
			missing_stages: [...missing],
			failure_class: failureClass
		}
	}
}

function quantile(values: readonly number[], fraction: number): number | null {
	if (!values.length) return null;
	const ordered = [...values].sort((a, b) => a - b);
	const position = (ordered.length - 1) * fraction;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return ordered[lower] ?? null;
	return (ordered[lower] ?? 0) + ((ordered[upper] ?? 0) - (ordered[lower] ?? 0)) * (position - lower);
}

function quantileSummary(values: readonly number[]): Jig186QuantileSummary {
	return { count: values.length, p50: quantile(values, 0.5), p90: quantile(values, 0.9) };
}

function serviceRestartCount(samples: readonly NormalizedHealthSample[]): number {
	const ordered = [...samples].sort((a, b) => a.observedAt - b.observedAt);
	let previous: string | null = null;
	let restarts = 0;
	for (const sample of ordered) {
		if (!sample.processInstanceId) continue;
		if (previous && sample.processInstanceId !== previous) restarts += 1;
		previous = sample.processInstanceId;
	}
	return restarts;
}

function alertRuns(samples: readonly NormalizedTelemetrySample[]): Jig186RunSample[] {
	return samples.map((sample) => ({
		observedAt: sample.observedAt,
		telemetry: {
			terminal_state: sample.telemetry.terminal_state,
			first_answer_ms: sample.telemetry.first_answer_ms,
			total_duration_ms: sample.telemetry.total_duration_ms,
			missing_stages: sample.telemetry.missing_stages,
			failure_class: sample.telemetry.failure_class
		}
	}));
}

/**
 * Build a bounded, content-free dashboard snapshot from authenticated health
 * summaries and JIG-182 durable telemetry summaries. Unknown input fields are
 * ignored. Invalid records are ignored. Oversized top-level arrays are
 * rejected before any work starts.
 */
export function buildJig186DashboardSnapshot(
	input: unknown,
	now = Date.now()
): Jig186DashboardSnapshot {
	if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('JIG-186 now must be a safe timestamp');
	const root = objectValue(input);
	if (!root) throw new TypeError('JIG-186 dashboard input must be an object');
	const health = boundedArray(root.health, 'health')
		.map(normalizeHealth)
		.filter((sample): sample is NormalizedHealthSample => sample !== null);
	const telemetry = boundedArray(root.telemetry, 'telemetry')
		.map(normalizeTelemetry)
		.filter((sample): sample is NormalizedTelemetrySample => sample !== null);

	const requiredReadyCount = health.filter((sample) => sample.requiredReady).length;
	const terminalStateCounts = countRecord(TERMINAL_STATES);
	const failureClassCounts = countRecord(FAILURE_CLASSES);
	const missingStageCounts = countRecord(MISSING_STAGES);
	const queueWait: number[] = [];
	const firstProgress: number[] = [];
	const firstText: number[] = [];
	const totalDuration: number[] = [];
	let reconnectSampleCount = 0;
	let reconnectCycles = 0;

	for (const sample of telemetry) {
		const data = sample.telemetry;
		terminalStateCounts[data.terminal_state as TerminalState] += 1;
		const failureClass = data.failure_class as FailureClass | null;
		failureClassCounts[failureClass ?? 'none'] += 1;
		for (const stage of data.missing_stages) missingStageCounts[stage as MissingStage] += 1;
		if (data.queue_wait_ms != null && !data.missing_stages.includes('queue_wait')) {
			queueWait.push(data.queue_wait_ms);
		}
		if (data.first_progress_ms != null && !data.missing_stages.includes('first_progress')) {
			firstProgress.push(data.first_progress_ms);
		}
		if (data.reconnect_count != null) {
			reconnectSampleCount += 1;
			reconnectCycles += data.reconnect_count;
		}
		if (data.terminal_state !== 'complete') continue;
		if (data.first_answer_ms != null && !data.missing_stages.includes('first_answer')) {
			firstText.push(data.first_answer_ms);
		}
		if (data.total_duration_ms != null && !data.missing_stages.includes('total_duration')) {
			totalDuration.push(data.total_duration_ms);
		}
	}

	const readiness: Jig186ReadinessSample[] = health.map(({ observedAt, requiredReady }) => ({
		observedAt,
		requiredReady
	}));
	const alerts = evaluateJig186Alerts(
		{ readiness, runs: alertRuns(telemetry) },
		now
	);
	return {
		health: {
			sampleCount: health.length,
			requiredReadyCount,
			requiredReadyRatio: health.length ? requiredReadyCount / health.length : null,
			statusBodyMismatchCount: health.filter((sample) => sample.statusBodyMismatch).length,
			serviceRestartCount: serviceRestartCount(health)
		},
		metrics: {
			queueWait: quantileSummary(queueWait),
			firstProgress: quantileSummary(firstProgress),
			firstText: quantileSummary(firstText),
			totalDuration: quantileSummary(totalDuration),
			reconnects: { sampleCount: reconnectSampleCount, totalCycles: reconnectCycles }
		},
		terminalStateCounts,
		failureClassCounts,
		missingStageCounts,
		alerts,
		runbook: JIG186_RUNBOOK
	};
}
