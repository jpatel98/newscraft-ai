import type { HermesRunEventRecord, HermesRunRecord } from '$lib/server/db/hermes-runs';

export const MATERIAL_STREAM_GAP_MS = 2_000;
export const MAX_DURABLE_TELEMETRY_EVENTS = 10_000;

const TRACE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const RUN_STATES = new Set([
	'queued',
	'researching',
	'writing',
	'reconnecting',
	'cancel_requested',
	'cancelled',
	'failed',
	'complete'
]);
const FAILURE_CLASSES = new Set([
	'cancelled',
	'callback',
	'network',
	'timeout',
	'upstream',
	'lease',
	'protocol',
	'start',
	'unknown'
]);

type DurableRunLike = Pick<
	HermesRunRecord,
	| 'state'
	| 'inputJson'
	| 'createdAt'
	| 'startedAt'
	| 'completedAt'
	| 'cancelRequestedAt'
>;

type DurableEventLike = Pick<HermesRunEventRecord, 'eventType' | 'dataJson' | 'createdAt' | 'cursor'>;

export interface DurableTelemetryContext {
	requestAcceptanceMs?: number;
	failureClass?: string;
	eventsTruncated?: boolean;
}

export interface DurableTelemetryCollection {
	events: DurableEventLike[];
	truncated: boolean;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseObject(value: string | undefined): Record<string, unknown> | null {
	if (!value) return null;
	try {
		return objectValue(JSON.parse(value));
	} catch {
		return null;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedDuration(value: number | null | undefined): number | null {
	if (value == null || !Number.isFinite(value)) return null;
	return Math.max(0, Math.round(value));
}

function safeRunState(value: string): string {
	return RUN_STATES.has(value) ? value : 'unknown';
}

export function isValidTraceId(value: unknown): value is string {
	return typeof value === 'string' && TRACE_ID_RE.test(value.trim());
}

export type DurableTraceBinding =
	| { kind: 'legacy' }
	| { kind: 'bound'; traceId: string }
	| { kind: 'invalid' };

/** Distinguish an old run with no trace from a malformed persisted binding. */
export function traceBindingFromHermesInput(inputJson: string | undefined): DurableTraceBinding {
	const input = parseObject(inputJson);
	if (!input) return { kind: 'invalid' };
	if (!Object.prototype.hasOwnProperty.call(input, 'trace_id')) return { kind: 'legacy' };
	const traceId = stringValue(input.trace_id);
	return traceId && isValidTraceId(traceId) ? { kind: 'bound', traceId } : { kind: 'invalid' };
}

export type DurableTraceBindingValidation =
	| { ok: true; traceId: string | null }
	| { ok: false; reason: 'persisted_invalid' | 'missing' | 'invalid' | 'mismatch' | 'legacy_supplied' };

/** Validate an internal control request before any run state mutation. */
export function validateDurableTraceBinding(
	inputJson: string | undefined,
	suppliedTraceId: unknown
): DurableTraceBindingValidation {
	if (suppliedTraceId !== undefined && !isValidTraceId(suppliedTraceId)) {
		return { ok: false, reason: 'invalid' };
	}
	const persisted = traceBindingFromHermesInput(inputJson);
	if (persisted.kind === 'invalid') return { ok: false, reason: 'persisted_invalid' };
	if (persisted.kind === 'legacy') {
		return suppliedTraceId === undefined
			? { ok: true, traceId: null }
			: { ok: false, reason: 'legacy_supplied' };
	}
	if (suppliedTraceId === undefined) return { ok: false, reason: 'missing' };
	if (!isValidTraceId(suppliedTraceId)) return { ok: false, reason: 'invalid' };
	return suppliedTraceId.trim() === persisted.traceId
		? { ok: true, traceId: persisted.traceId }
		: { ok: false, reason: 'mismatch' };
}

/** Read only the server-persisted correlation id from a durable run input. */
export function traceIdFromHermesInput(inputJson: string | undefined): string | null {
	const binding = traceBindingFromHermesInput(inputJson);
	return binding.kind === 'bound' ? binding.traceId : null;
}

function eventData(event: DurableEventLike): Record<string, unknown> {
	return parseObject(event.dataJson) || {};
}

function toolStage(name: unknown): 'search' | 'browser' | 'extraction' | 'archive' | null {
	const normalized = stringValue(name)?.toLowerCase() || '';
	if (normalized.includes('browser')) return 'browser';
	if (normalized.includes('extract')) return 'extraction';
	if (normalized.includes('archive') || normalized.includes('wayback')) return 'archive';
	if (normalized.includes('search') || normalized.includes('verify_this_lead')) return 'search';
	return null;
}

function failureClass(
	run: DurableRunLike,
	events: DurableEventLike[],
	context: DurableTelemetryContext
): string | null {
	if (context.failureClass && FAILURE_CLASSES.has(context.failureClass)) return context.failureClass;
	for (const event of [...events].reverse()) {
		const candidate = stringValue(eventData(event).failure_class);
		if (candidate && FAILURE_CLASSES.has(candidate)) return candidate;
		if (event.eventType === 'run.cancelled') return 'cancelled';
	}
	if (run.state === 'cancelled') return 'cancelled';
	if (run.state === 'failed') return 'unknown';
	return null;
}

function usageMetadata(run: DurableRunLike, events: DurableEventLike[]): Record<string, unknown> {
	const usage = {
		provider: 'hermes-chat',
		provider_calls: run.startedAt == null ? 0 : 1,
		retrieval_backend: 'unknown',
		archive_provider: 'unknown',
		search_calls: 0,
		browser_calls: 0,
		extraction_calls: 0,
		archive_calls: 0
	};
	const forwardedProps = objectValue(parseObject(run.inputJson)?.forwardedProps);
	if (forwardedProps?.retrievalBackend === 'newscraft-local') usage.retrieval_backend = 'newscraft-local';
	if (forwardedProps?.archiveFallback === 'wayback') usage.archive_provider = 'wayback';

	const seenTools = new Set<string>();
	const seenArchiveSources = new Set<string>();
	const archiveToolIds = new Set<string>();
	for (const [index, event] of events.entries()) {
		if (event.eventType !== 'agent.tool.progress') continue;
		const data = eventData(event);
		if (toolStage(data.name) === 'archive') {
			const id = stringValue(data.id) || `event-${event.cursor ?? index}`;
			archiveToolIds.add(id);
		}
	}
	for (const [index, event] of events.entries()) {
		const data = eventData(event);
		if (event.eventType === 'agent.tool.progress') {
			const stage = toolStage(data.name);
			if (!stage) continue;
			const id = stringValue(data.id) || `event-${event.cursor ?? index}`;
			const key = `${stage}:${id}`;
			if (seenTools.has(key)) continue;
			seenTools.add(key);
			usage[`${stage}_calls` as 'search_calls' | 'browser_calls' | 'extraction_calls' | 'archive_calls'] += 1;
			continue;
		}
		if (event.eventType === 'agent.source.read') {
			const source = objectValue(data.source);
			const retrieval = objectValue(source?.retrieval);
			const mode = stringValue(retrieval?.retrievalMode)?.toLowerCase() || '';
			if (mode.includes('archive') || mode.includes('wayback') || typeof retrieval?.archivedUrl === 'string') {
				const sourceId = stringValue(source?.id) || stringValue(source?.url);
				if (sourceId && !seenArchiveSources.has(sourceId) && archiveToolIds.size === 0) {
					seenArchiveSources.add(sourceId);
					usage.archive_calls += 1;
				}
			}
		}
	}
	return usage;
}

function hasAnswerText(event: DurableEventLike): boolean {
	const data = eventData(event);
	if (event.eventType === 'response.output_text.delta') return Boolean(stringValue(data.delta));
	return event.eventType === 'agent.answer.replace' && Boolean(stringValue(data.content));
}

function isProgressEvent(eventType: string): boolean {
	return (
		eventType === 'run.started' ||
		eventType === 'agent.tool.progress' ||
		eventType === 'agent.source.read' ||
		eventType === 'agent.citations' ||
		eventType === 'run.reconnecting' ||
		eventType === 'run.reconnected'
	);
}

/**
 * Produce a bounded, content-free summary from persisted durable events.
 * Event payloads are deliberately not copied into this object.
 */
export function summarizeDurableRunTelemetry(
	run: DurableRunLike,
	events: DurableEventLike[],
	context: DurableTelemetryContext = {}
): Record<string, unknown> {
	const ordered = [...events].sort((a, b) => a.createdAt - b.createdAt || (a.cursor ?? 0) - (b.cursor ?? 0));
	const firstProgress = ordered.find((event) => isProgressEvent(event.eventType));
	const firstAnswer = ordered.find((event) => hasAnswerText(event));
	let materialStreamGapCount = 0;
	let maxMaterialStreamGapMs = 0;
	for (let index = 1; index < ordered.length; index += 1) {
		const gap = ordered[index].createdAt - ordered[index - 1].createdAt;
		if (gap > MATERIAL_STREAM_GAP_MS) {
			materialStreamGapCount += 1;
			maxMaterialStreamGapMs = Math.max(maxMaterialStreamGapMs, gap);
		}
	}
	const retryCount = ordered.filter(
		(event) => ['run.retry', 'response.retry', 'retry'].includes(event.eventType) || eventData(event).retry === true
	).length;
	let reconnectCount = 0;
	let reconnectOpen = false;
	for (const event of ordered) {
		if (['run.reconnecting', 'response.reconnecting'].includes(event.eventType)) {
			// Count the cycle at its start. A matching completion only closes it.
			if (!reconnectOpen) reconnectCount += 1;
			reconnectOpen = true;
		} else if (['run.reconnected', 'response.reconnected'].includes(event.eventType)) {
			reconnectOpen = false;
		}
	}
	const cancellationRequested =
		Boolean(run.cancelRequestedAt) || ordered.some((event) => event.eventType === 'run.cancel_requested');
	const terminalState = safeRunState(run.state);
	const firstProgressMs = firstProgress ? boundedDuration(firstProgress.createdAt - run.createdAt) : null;
	const firstAnswerMs = firstAnswer ? boundedDuration(firstAnswer.createdAt - run.createdAt) : null;
	const missingStages = [
		...(run.startedAt == null ? ['queue_wait'] : []),
		...(firstProgressMs == null ? ['first_progress'] : []),
		...(firstAnswerMs == null ? ['first_answer'] : []),
		...(run.completedAt == null ? ['total_duration'] : [])
	];

	return {
		...(traceIdFromHermesInput(run.inputJson) ? { trace_id: traceIdFromHermesInput(run.inputJson) } : {}),
		terminal_state: terminalState,
		request_acceptance_ms: boundedDuration(context.requestAcceptanceMs),
		queue_wait_ms: run.startedAt == null ? null : boundedDuration(run.startedAt - run.createdAt),
		first_progress_ms: firstProgressMs,
		first_answer_ms: firstAnswerMs,
		material_stream_gap_count: materialStreamGapCount,
		max_material_stream_gap_ms: maxMaterialStreamGapMs,
		total_duration_ms:
			run.completedAt == null ? null : boundedDuration(run.completedAt - run.createdAt),
		retry_count: retryCount,
		reconnect_count: reconnectCount,
		cancel_requested: cancellationRequested,
		cancelled: terminalState === 'cancelled',
		failure_class: failureClass(run, ordered, context),
		event_count: ordered.length,
		events_truncated: context.eventsTruncated === true,
		missing_stages: missingStages,
		usage: usageMetadata(run, ordered)
	};
}

/** Read saved events in bounded pages and a bounded total for a terminal summary. */
export async function collectDurableRunEvents(
	accountId: string,
	runId: string,
	listEvents: (
		accountId: string,
		runId: string,
		afterCursor: number,
		limit: number
	) => Promise<DurableEventLike[]>
): Promise<DurableTelemetryCollection> {
	const events: DurableEventLike[] = [];
	let afterCursor = 0;
	for (;;) {
		const page = await listEvents(accountId, runId, afterCursor, 1000);
		if (!page.length) break;
		const remaining = MAX_DURABLE_TELEMETRY_EVENTS - events.length;
		if (page.length > remaining) {
			events.push(...page.slice(0, remaining));
			return { events, truncated: true };
		}
		events.push(...page);
		const nextCursor = page[page.length - 1]?.cursor ?? afterCursor;
		if (nextCursor <= afterCursor || page.length < 1000) break;
		afterCursor = nextCursor;
		if (events.length === MAX_DURABLE_TELEMETRY_EVENTS) {
			const nextPage = await listEvents(accountId, runId, afterCursor, 1);
			return { events, truncated: nextPage.length > 0 };
		}
	}
	return { events, truncated: false };
}
