import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './index';
import { conversations, hermesRunEvents, hermesRuns, messages, messageProvenance } from './schema';
import { newId } from '$lib/utils/id';
import {
	serializeToolMetadata,
	buildAnswerProvenanceBundle,
	citationRecordsUsedInAnswer
} from '$lib/utils/tool-metadata';
import { sanitizeUnresolvedCitationMarkers, truncateReadableAnswer } from '$lib/utils/stream-events';
import type { CitationRecord } from '@newscraft/shared';
import type { PersistedSource, StreamToolCall } from '$lib/utils/stream-events';

export type HermesRunState =
	| 'queued'
	| 'researching'
	| 'writing'
	| 'reconnecting'
	| 'cancel_requested'
	| 'cancelled'
	| 'failed'
	| 'complete';

export const HERMES_ACTIVE_STATES: HermesRunState[] = [
	'queued',
	'researching',
	'writing',
	'reconnecting',
	'cancel_requested'
];

export const HERMES_TERMINAL_STATES: HermesRunState[] = ['cancelled', 'failed', 'complete'];
export const HERMES_LEASE_MS = 10 * 60 * 1000;
export const HERMES_MAX_EVENT_BYTES = 128 * 1024;
export const HERMES_MAX_ANSWER_CHARS = 512 * 1024;
export const HERMES_MAX_SNAPSHOT_ITEMS = 100;

export interface HermesRunEventInput {
	eventType: string;
	dataJson: string;
	workerCursor: number;
}

export interface HermesRunCreateInput {
	id?: string;
	accountId: string;
	orgId: string | null;
	conversationId: string;
	userMessageId: string | null;
	assistantMessageId: string;
	preparedClaimToken?: number;
	idempotencyKey: string;
	tenantKey: string;
	sessionId: string;
	inputJson: string;
	seededCitationsJson?: string;
}

export type HermesRunRecord = typeof hermesRuns.$inferSelect;
export type HermesRunEventRecord = typeof hermesRunEvents.$inferSelect;
export type HermesRunEventRead = Pick<
	HermesRunEventRecord,
	'cursor' | 'eventType' | 'dataJson' | 'createdAt'
>;
export type HermesRunSubscriptionEvent = Pick<
	HermesRunEventRecord,
	'cursor' | 'eventType' | 'dataJson'
>;
export type HermesRunSubscriptionState = Pick<HermesRunRecord, 'state' | 'cursor'>;
export type HermesRunMessageState = Pick<
	HermesRunRecord,
	'assistantMessageId' | 'state' | 'errorMessage'
>;

export class HermesRunRepositoryError extends Error {
	readonly code:
		| 'invalid_input'
		| 'not_found'
		| 'cross_account'
		| 'stale_lease'
		| 'stale_callback'
		| 'terminal';

	constructor(
		code: HermesRunRepositoryError['code'],
		message: string
	) {
		super(message);
		this.name = 'HermesRunRepositoryError';
		this.code = code;
	}
}

function requireValue(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new HermesRunRepositoryError('invalid_input', `${label} is required`);
	return normalized;
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function boundedJson(value: string, label: string): string {
	if (Buffer.byteLength(value, 'utf8') > HERMES_MAX_EVENT_BYTES) {
		throw new HermesRunRepositoryError('invalid_input', `${label} is too large`);
	}
	return value;
}

function normalizeState(value: string | null | undefined): HermesRunState {
	if (
		value === 'queued' ||
		value === 'researching' ||
		value === 'writing' ||
		value === 'reconnecting' ||
		value === 'cancel_requested' ||
		value === 'cancelled' ||
		value === 'failed' ||
		value === 'complete'
	) {
		return value;
	}
	return 'queued';
}

function isTerminal(state: HermesRunState): boolean {
	return HERMES_TERMINAL_STATES.includes(state);
}

function nextState(
	current: HermesRunState,
	eventType: string,
	data: Record<string, unknown>
): HermesRunState {
	if (eventType === 'run.cancelled' || eventType === 'cancelled') return 'cancelled';
	if (eventType === 'run.failed' || eventType === 'response.failed') return 'failed';
	if (eventType === 'response.completed' || eventType === 'run.complete' || eventType === 'run.finished') {
		return 'complete';
	}
	if (eventType === 'run.reconnecting') return 'reconnecting';
	if (eventType === 'response.output_text.delta' || eventType === 'agent.answer.replace') return 'writing';
	if (eventType === 'agent.tool.progress' || eventType.startsWith('agent.source') || eventType === 'agent.citations') {
		return current === 'writing' ? current : 'researching';
	}
	if (eventType === 'run.started' || eventType === 'agent.meta') return 'researching';
	if (data.status === 'cancelled') return 'cancelled';
	if (data.status === 'failed' || data.status === 'error') return 'failed';
	if (data.status === 'complete' || data.status === 'completed') return 'complete';
	return current;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function itemKey(value: Record<string, unknown>, fallback: string): string {
	return stringValue(value.id) || stringValue(value.url) || fallback;
}

export interface HermesRunSnapshot {
	state: HermesRunState;
	answerText: string;
	sources: PersistedSource[];
	citations: CitationRecord[];
	tools: StreamToolCall[];
	errorMessage: string | null;
}

export function snapshotFromRun(run: HermesRunRecord): HermesRunSnapshot {
	return {
		state: normalizeState(run.state),
		answerText: run.answerText,
		sources: parseJson<PersistedSource[]>(run.sourcesJson, []),
		citations: parseJson<CitationRecord[]>(run.citationsJson, []),
		tools: parseJson<StreamToolCall[]>(run.toolsJson, []),
		errorMessage: run.errorMessage
	};
}

function applyHermesRunEventData(
	run: HermesRunRecord,
	eventType: string,
	data: Record<string, unknown>
): HermesRunSnapshot {
	const snapshot = snapshotFromRun(run);
	let answerText = snapshot.answerText;
	if (eventType === 'response.output_text.delta') {
		const delta = stringValue(data.delta);
		if (delta) answerText = `${answerText}${delta}`;
	}
	if (eventType === 'agent.answer.replace' && typeof data.content === 'string') {
		answerText = data.content;
	}
	const resultingState = nextState(snapshot.state, eventType, data);
	answerText = isTerminal(resultingState)
		? truncateReadableAnswer(answerText, HERMES_MAX_ANSWER_CHARS, true)
		: answerText.slice(0, HERMES_MAX_ANSWER_CHARS);

	const sources = [...snapshot.sources];
	const sourceValue = objectValue(data.source) || (eventType.startsWith('agent.source') ? data : null);
	if (sourceValue) {
		const key = itemKey(sourceValue, `source-${sources.length + 1}`);
		const index = sources.findIndex((source) => itemKey(source as unknown as Record<string, unknown>, '') === key);
		const source = sourceValue as unknown as PersistedSource;
		if (index >= 0) sources[index] = { ...sources[index], ...source };
		else sources.push(source);
	}

	const citations = [...snapshot.citations];
	if (Array.isArray(data.citations)) {
		for (const raw of data.citations) {
			const citation = objectValue(raw) as CitationRecord | null;
			if (!citation) continue;
			const key = `${citation.citationNumber}\u0000${citation.url}\u0000${citation.documentPage ?? ''}`;
			const index = citations.findIndex(
				(item) => `${item.citationNumber}\u0000${item.url}\u0000${item.documentPage ?? ''}` === key
			);
			if (index >= 0) citations[index] = { ...citations[index], ...citation };
			else citations.push(citation);
		}
	}

	const tools = [...snapshot.tools];
	const tool = objectValue(data);
	if (eventType === 'agent.tool.progress' && tool) {
		const key = itemKey(tool, `tool-${tools.length + 1}`);
		const index = tools.findIndex((item) => item.id === key);
		const nextTool = { ...(tool as unknown as StreamToolCall), id: key };
		if (index >= 0) tools[index] = { ...tools[index], ...nextTool };
		else tools.push(nextTool);
	}

	return {
		state: resultingState,
		answerText,
		sources: sources.slice(-HERMES_MAX_SNAPSHOT_ITEMS),
		citations: citations.slice(-HERMES_MAX_SNAPSHOT_ITEMS),
		tools: tools.slice(-HERMES_MAX_SNAPSHOT_ITEMS),
		errorMessage:
			eventType === 'response.failed' || eventType === 'run.failed'
				? stringValue(objectValue(data.error)?.message) || stringValue(data.message) || 'Hermes run failed.'
				: snapshot.errorMessage
	};
}

export function applyHermesRunEvent(
	run: HermesRunRecord,
	eventType: string,
	dataJson: string
): HermesRunSnapshot {
	return applyHermesRunEventData(run, eventType, objectValue(parseJson<unknown>(dataJson, {})) || {});
}

export async function createOrGetHermesRun(
	input: HermesRunCreateInput
): Promise<{ run: HermesRunRecord; created: boolean }> {
	const accountId = requireValue(input.accountId, 'accountId');
	const conversationId = requireValue(input.conversationId, 'conversationId');
	const assistantMessageId = requireValue(input.assistantMessageId, 'assistantMessageId');
	const idempotencyKey = requireValue(input.idempotencyKey, 'idempotencyKey');
	const tenantKey = requireValue(input.tenantKey, 'tenantKey');
	const sessionId = requireValue(input.sessionId, 'sessionId');
	const inputJson = boundedJson(input.inputJson, 'inputJson');
	const seededCitationsJson = boundedJson(input.seededCitationsJson || '[]', 'seededCitationsJson');
	const now = Date.now();
	const id = input.id?.trim() || newId();
	return db.transaction(async (tx: any) => {
		// The assistant placeholder is the stable identity for a resume. Lock it
		// before checking active runs so concurrent browser retries cannot create
		// two jobs for the same persisted answer row. The conversation join keeps
		// the account binding inside the same transaction.
		const boundAssistant = await tx.execute(
			sql`SELECT messages.id FROM messages
				JOIN conversations ON conversations.id = messages.conversation_id
				WHERE messages.id = ${assistantMessageId}
					AND messages.conversation_id = ${conversationId}
					AND conversations.account_id = ${accountId}
				FOR UPDATE OF messages`
		);
		if (!boundAssistant.length) {
			throw new HermesRunRepositoryError('not_found', 'assistant message is not owned by account');
		}
		if (input.userMessageId) {
			const boundUser = await tx.execute(
				sql`SELECT messages.id FROM messages
					JOIN conversations ON conversations.id = messages.conversation_id
					WHERE messages.id = ${input.userMessageId}
						AND messages.conversation_id = ${conversationId}
						AND conversations.account_id = ${accountId}`
			);
			if (!boundUser.length) throw new HermesRunRepositoryError('not_found', 'user message is not owned by account');
		}
		const [active] = (await tx
			.select()
			.from(hermesRuns)
			.where(
				and(
					eq(hermesRuns.accountId, accountId),
					eq(hermesRuns.conversationId, conversationId),
					eq(hermesRuns.assistantMessageId, assistantMessageId),
					inArray(hermesRuns.state, HERMES_ACTIVE_STATES)
				)
			)
			.orderBy(desc(hermesRuns.updatedAt))
			.limit(1)) as HermesRunRecord[];
		if (active) return { run: active, created: false };
		if (input.preparedClaimToken !== undefined) {
			const [prepared] = await tx
				.select({ claimToken: messages.resumeClaimedAt, partial: messages.partial })
				.from(messages)
				.where(and(eq(messages.id, assistantMessageId), eq(messages.conversationId, conversationId)))
				.limit(1);
			if (
				!prepared ||
				prepared.partial !== 1 ||
				prepared.claimToken !== input.preparedClaimToken
			) {
				throw new HermesRunRepositoryError('stale_callback', 'prepared turn ownership is stale');
			}
		}

		const [inserted] = await tx
			.insert(hermesRuns)
			.values({
				id,
				accountId,
				orgId: input.orgId,
				conversationId,
				userMessageId: input.userMessageId,
				assistantMessageId,
				idempotencyKey,
				tenantKey,
				sessionId,
				inputJson,
				seededCitationsJson,
				state: 'queued',
				answerText: '',
				sourcesJson: '[]',
				citationsJson: seededCitationsJson,
				toolsJson: '[]',
				cursor: 0,
				workerCursor: 0,
				errorMessage: null,
				cancelRequestedAt: null,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null,
				createdAt: now,
				startedAt: null,
				updatedAt: now,
				completedAt: null
			})
			.onConflictDoNothing({ target: [hermesRuns.accountId, hermesRuns.idempotencyKey] })
			.returning();
		if (inserted) {
			if (input.preparedClaimToken !== undefined) {
				await tx
					.update(messages)
					.set({ resumeClaimedAt: null })
					.where(
						and(
							eq(messages.id, assistantMessageId),
							eq(messages.resumeClaimedAt, input.preparedClaimToken)
						)
					);
			}
			return { run: inserted, created: true };
		}
		const [existing] = (await tx
			.select()
			.from(hermesRuns)
			.where(and(eq(hermesRuns.accountId, accountId), eq(hermesRuns.idempotencyKey, idempotencyKey)))
			.limit(1)) as HermesRunRecord[];
		if (!existing) throw new HermesRunRepositoryError('not_found', 'run disappeared after idempotent insert');
		return { run: existing, created: false };
	});
}

/**
 * Create one stable assistant placeholder for an idempotent durable turn.
 * The account and conversation check is part of this operation. This keeps
 * duplicate browser submissions from creating duplicate assistant rows.
 */
export async function ensureHermesAssistantMessage(
	accountId: string,
	conversationId: string,
	idempotencyKey: string
): Promise<string> {
	const owner = requireValue(accountId, 'accountId');
	const conversation = requireValue(conversationId, 'conversationId');
	const key = requireValue(idempotencyKey, 'idempotencyKey');
	const [ownedConversation] = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(and(eq(conversations.id, conversation), eq(conversations.accountId, owner)))
		.limit(1);
	if (!ownedConversation) throw new HermesRunRepositoryError('cross_account', 'conversation is not owned by account');
	const id = `hermes-assistant-${createHash('sha256')
		.update(`${owner}\u0000${conversation}\u0000${key}`)
		.digest('hex')}`;
	const now = Date.now();
	await db
		.insert(messages)
		.values({
			id,
			conversationId: conversation,
			role: 'assistant',
			content: '',
			toolCalls: null,
			partial: 1,
			resumeClaimedAt: null,
			createdAt: now
		})
		.onConflictDoNothing({ target: messages.id });
	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversation));
	return id;
}

export async function getHermesRun(
	accountId: string,
	value: string,
	by: 'id' | 'idempotency' = 'id'
): Promise<HermesRunRecord | null> {
	const owner = requireValue(accountId, 'accountId');
	const key = requireValue(value, by === 'id' ? 'runId' : 'idempotencyKey');
	const rows = await db
		.select()
		.from(hermesRuns)
		.where(and(eq(hermesRuns.accountId, owner), by === 'id' ? eq(hermesRuns.id, key) : eq(hermesRuns.idempotencyKey, key)))
		.limit(1);
	return (rows[0] as HermesRunRecord | undefined) || null;
}

/** Read only the fields needed by a live subscription poll. */
export async function getHermesRunSubscriptionState(
	accountId: string,
	runId: string
): Promise<HermesRunSubscriptionState | null> {
	const rows = await db
		.select({ state: hermesRuns.state, cursor: hermesRuns.cursor })
		.from(hermesRuns)
		.where(
			and(
				eq(hermesRuns.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRuns.id, requireValue(runId, 'runId'))
			)
		)
		.limit(1);
	return (rows[0] as HermesRunSubscriptionState | undefined) || null;
}

export async function getHermesRunForAssistant(
	accountId: string,
	conversationId: string,
	assistantMessageId: string
): Promise<HermesRunRecord | null> {
	const rows = await db
		.select()
		.from(hermesRuns)
		.where(
			and(
				eq(hermesRuns.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRuns.conversationId, requireValue(conversationId, 'conversationId')),
				eq(hermesRuns.assistantMessageId, requireValue(assistantMessageId, 'assistantMessageId')),
				inArray(hermesRuns.state, HERMES_ACTIVE_STATES)
			)
		)
		.orderBy(desc(hermesRuns.updatedAt))
		.limit(1);
	return (rows[0] as HermesRunRecord | undefined) || null;
}

export async function getActiveHermesRun(
	accountId: string,
	conversationId: string
): Promise<HermesRunRecord | null> {
	const rows = await db
		.select()
		.from(hermesRuns)
		.where(
			and(
				eq(hermesRuns.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRuns.conversationId, requireValue(conversationId, 'conversationId')),
				inArray(hermesRuns.state, HERMES_ACTIVE_STATES)
			)
		)
		.orderBy(desc(hermesRuns.updatedAt))
		.limit(1);
	return (rows[0] as HermesRunRecord | undefined) || null;
}

export async function listHermesRunsForConversation(
	accountId: string,
	conversationId: string
): Promise<HermesRunMessageState[]> {
	const owner = requireValue(accountId, 'accountId');
	const conversation = requireValue(conversationId, 'conversationId');
	return (await db
		.select({
			assistantMessageId: hermesRuns.assistantMessageId,
			state: hermesRuns.state,
			errorMessage: hermesRuns.errorMessage
		})
		.from(hermesRuns)
		.where(and(eq(hermesRuns.accountId, owner), eq(hermesRuns.conversationId, conversation)))
		.orderBy(desc(hermesRuns.createdAt))
		.limit(500)) as HermesRunMessageState[];
}

/** Read the newest durable state for the explicitly requested assistant ids. */
export async function listHermesRunStatesForMessages(
	accountId: string,
	conversationId: string,
	messageIds: string[]
): Promise<HermesRunMessageState[]> {
	const owner = requireValue(accountId, 'accountId');
	const conversation = requireValue(conversationId, 'conversationId');
	const ids = Array.from(new Set(messageIds.map((id) => id.trim()).filter(Boolean)));
	if (ids.length === 0) return [];
	const rows = (await db
		.select({
			assistantMessageId: hermesRuns.assistantMessageId,
			state: hermesRuns.state,
			errorMessage: hermesRuns.errorMessage,
			createdAt: hermesRuns.createdAt,
			id: hermesRuns.id
		})
		.from(hermesRuns)
		.where(
			and(
				eq(hermesRuns.accountId, owner),
				eq(hermesRuns.conversationId, conversation),
				inArray(hermesRuns.assistantMessageId, ids)
			)
		)
		.orderBy(desc(hermesRuns.createdAt), desc(hermesRuns.id))) as Array<
		Pick<HermesRunRecord, 'assistantMessageId' | 'state' | 'errorMessage' | 'createdAt' | 'id'>
	>;
	const latest = new Map<string, HermesRunMessageState>();
	for (const row of rows) {
		if (!latest.has(row.assistantMessageId)) {
			latest.set(row.assistantMessageId, {
				assistantMessageId: row.assistantMessageId,
				state: row.state,
				errorMessage: row.errorMessage
			});
		}
	}
	return [...latest.values()];
}

export async function listHermesRunEvents(
	accountId: string,
	runId: string,
	afterCursor = 0,
	limit = 500
): Promise<HermesRunEventRead[]> {
	if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
		throw new HermesRunRepositoryError('invalid_input', 'afterCursor must be a non-negative integer');
	}
	const run = await getHermesRun(accountId, runId);
	if (!run) throw new HermesRunRepositoryError('not_found', 'run not found');
	return (await db
		.select({
			cursor: hermesRunEvents.cursor,
			eventType: hermesRunEvents.eventType,
			dataJson: hermesRunEvents.dataJson,
			createdAt: hermesRunEvents.createdAt
		})
		.from(hermesRunEvents)
		.where(
			and(
				eq(hermesRunEvents.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRunEvents.runId, run.id),
				gt(hermesRunEvents.cursor, afterCursor)
			)
		)
		.orderBy(asc(hermesRunEvents.cursor))
		.limit(Math.min(Math.max(limit, 1), 1000))) as HermesRunEventRead[];
}

/**
 * List events after the caller has already verified the tenant-bound run.
 * Both account and run remain part of the query boundary.
 */
export async function listKnownHermesRunEvents(
	accountId: string,
	runId: string,
	afterCursor = 0,
	limit = 500
): Promise<HermesRunSubscriptionEvent[]> {
	if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
		throw new HermesRunRepositoryError('invalid_input', 'afterCursor must be a non-negative integer');
	}
	return (await db
		.select({
			cursor: hermesRunEvents.cursor,
			eventType: hermesRunEvents.eventType,
			dataJson: hermesRunEvents.dataJson
		})
		.from(hermesRunEvents)
		.where(
			and(
				eq(hermesRunEvents.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRunEvents.runId, requireValue(runId, 'runId')),
				gt(hermesRunEvents.cursor, afterCursor)
			)
		)
		.orderBy(asc(hermesRunEvents.cursor))
		.limit(Math.min(Math.max(limit, 1), 1000))) as HermesRunSubscriptionEvent[];
}

export async function appendHermesRunEvent(
	accountId: string,
	runId: string,
	leaseOwner: string,
	leaseToken: string,
	input: HermesRunEventInput
): Promise<{ run: HermesRunRecord; event: HermesRunEventRecord }> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const worker = requireValue(leaseOwner, 'leaseOwner');
	const token = requireValue(leaseToken, 'leaseToken');
	if (!Number.isSafeInteger(input.workerCursor) || input.workerCursor < 1) {
		throw new HermesRunRepositoryError('invalid_input', 'workerCursor must be a positive integer');
	}
	const eventType = requireValue(input.eventType, 'eventType');
	const dataJson = boundedJson(input.dataJson, 'event data');
	const now = Date.now();

	return db.transaction(async (tx: any) => {
		const [current] = (await tx
			.select()
			.from(hermesRuns)
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.for('update')
			.limit(1)) as HermesRunRecord[];
		if (!current) throw new HermesRunRepositoryError('not_found', 'run not found');
		const state = normalizeState(current.state);
		if (current.leaseOwner !== worker || current.leaseToken !== token || !current.leaseExpiresAt || current.leaseExpiresAt <= now) {
			throw new HermesRunRepositoryError('stale_lease', 'run lease is stale');
		}
		if (isTerminal(state)) throw new HermesRunRepositoryError('terminal', 'run is already terminal');
		if (state === 'cancel_requested' && eventType !== 'run.cancelled' && eventType !== 'cancelled') {
			throw new HermesRunRepositoryError('stale_callback', 'callbacks after cancellation are not accepted');
		}
		if (input.workerCursor !== (current.workerCursor || 0) + 1) {
			throw new HermesRunRepositoryError('stale_callback', 'run callback cursor is not monotonic');
		}

		const eventData = objectValue(parseJson<unknown>(dataJson, {})) || {};
		const nextSnapshot = applyHermesRunEventData(current, eventType, eventData);
		const completedCitations =
			nextSnapshot.state === 'complete'
				? citationRecordsUsedInAnswer(nextSnapshot.answerText, nextSnapshot.citations)
				: nextSnapshot.citations;
		const snapshot =
			nextSnapshot.state === 'complete'
				? {
						...nextSnapshot,
						answerText: sanitizeUnresolvedCitationMarkers(
							nextSnapshot.answerText,
							completedCitations
						),
						citations: completedCitations
					}
				: nextSnapshot;
		const cursor = current.cursor + 1;
		const [event] = (await tx
			.insert(hermesRunEvents)
			.values({
				runId: id,
				accountId: owner,
				cursor,
				eventType,
				dataJson,
				createdAt: now
			})
			.returning()) as HermesRunEventRecord[];
		if (!event) throw new Error('Hermes run event insert returned no row');
		const terminal = isTerminal(snapshot.state);
		const sourceEvent = Boolean(objectValue(eventData.source)) || eventType.startsWith('agent.source');
		const citationEvent = Array.isArray(eventData.citations) || snapshot.state === 'complete';
		const toolEvent = eventType === 'agent.tool.progress';
		const runUpdate: Partial<typeof hermesRuns.$inferInsert> = {
			cursor,
			workerCursor: input.workerCursor,
			updatedAt: now,
			leaseExpiresAt: terminal ? null : now + HERMES_LEASE_MS
		};
		if (snapshot.state !== current.state) runUpdate.state = snapshot.state;
		if (snapshot.answerText !== current.answerText) runUpdate.answerText = snapshot.answerText;
		if (snapshot.errorMessage !== current.errorMessage) runUpdate.errorMessage = snapshot.errorMessage;
		const startedAt = current.startedAt ?? now;
		if (startedAt !== current.startedAt) runUpdate.startedAt = startedAt;
		const completedAt = terminal ? now : current.completedAt;
		if (completedAt !== current.completedAt) runUpdate.completedAt = completedAt;
		// Keep the existing JSON text for event types that cannot change it.
		// This avoids both serialization and an unnecessary column assignment.
		if (sourceEvent) {
			const sourcesJson = JSON.stringify(snapshot.sources);
			if (sourcesJson !== current.sourcesJson) runUpdate.sourcesJson = sourcesJson;
		}
		if (citationEvent) {
			const citationsJson = JSON.stringify(snapshot.citations);
			if (citationsJson !== current.citationsJson) runUpdate.citationsJson = citationsJson;
		}
		if (toolEvent) {
			const toolsJson = JSON.stringify(snapshot.tools);
			if (toolsJson !== current.toolsJson) runUpdate.toolsJson = toolsJson;
		}
		const [run] = (await tx
			.update(hermesRuns)
			.set(runUpdate)
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.returning()) as HermesRunRecord[];
		if (!run) throw new HermesRunRepositoryError('not_found', 'run disappeared during event append');

		const messageUpdate: Partial<typeof messages.$inferInsert> = {
			content: snapshot.answerText,
			partial: terminal && snapshot.state === 'complete' ? 0 : 1
		};
		// The first callback establishes metadata for the placeholder. Later
		// text-only callbacks cannot change sources, citations, or tools.
		if (current.cursor === 0 || sourceEvent || citationEvent || toolEvent || terminal) {
			messageUpdate.toolCalls = serializeToolMetadata(snapshot.tools, snapshot.sources, snapshot.citations);
		}
		await tx
			.update(messages)
			.set(messageUpdate)
			.where(and(eq(messages.id, current.assistantMessageId), eq(messages.conversationId, current.conversationId)));
		const provenance = buildAnswerProvenanceBundle({
			messageId: current.assistantMessageId,
			conversationId: current.conversationId,
			tools: snapshot.tools,
			sources: snapshot.sources,
			citations: snapshot.citations,
			answerText: snapshot.answerText,
			startedAt: run.startedAt ?? now,
			endedAt: terminal ? now : undefined,
			assistantChars: snapshot.answerText.length,
			done: snapshot.state === 'complete',
			finishStatus: snapshot.state === 'complete' ? 'completed' : snapshot.state === 'cancelled' ? 'cancelled' : snapshot.state === 'failed' ? 'failed' : 'partial',
			transport: 'hermes_durable'
		});
		const provenanceJson = JSON.stringify(provenance);
		await tx
			.insert(messageProvenance)
			.values({
				messageId: current.assistantMessageId,
				conversationId: current.conversationId,
				provenanceJson,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: messageProvenance.messageId,
				set: { provenanceJson, updatedAt: now }
			});
		await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, current.conversationId));
		return { run, event };
	});
}

export async function requestHermesRunCancellation(
	accountId: string,
	runId: string,
	reason = 'user_requested'
): Promise<HermesRunRecord> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(
			sql`SELECT id FROM hermes_runs WHERE id = ${id} AND account_id = ${owner} FOR UPDATE`
		);
		const [current] = (await tx
			.select()
			.from(hermesRuns)
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.limit(1)) as HermesRunRecord[];
		if (!current) throw new HermesRunRepositoryError('not_found', 'run not found');
		if (isTerminal(normalizeState(current.state)) || normalizeState(current.state) === 'cancel_requested') return current;
		const cursor = current.cursor + 1;
		await tx.insert(hermesRunEvents).values({
			runId: id,
			accountId: owner,
			cursor,
			eventType: 'run.cancel_requested',
			dataJson: JSON.stringify({ reason }),
			createdAt: now
		});
		const [run] = (await tx
			.update(hermesRuns)
			.set({ state: 'cancel_requested', cancelRequestedAt: now, cursor, updatedAt: now })
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.returning()) as HermesRunRecord[];
		if (!run) throw new HermesRunRepositoryError('not_found', 'run disappeared during cancellation');
		return run;
	});
}

export async function failQueuedHermesRun(
	accountId: string,
	runId: string,
	errorMessage = 'Research service did not start. Try again.',
	failureClass: 'start' | 'overload' = 'start'
): Promise<HermesRunRecord> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const safeError = errorMessage.trim().slice(0, 2_000) || 'Research service did not start. Try again.';
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(sql`SELECT id FROM hermes_runs WHERE id = ${id} AND account_id = ${owner} FOR UPDATE`);
		const [current] = (await tx
			.select()
			.from(hermesRuns)
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.limit(1)) as HermesRunRecord[];
		if (!current) throw new HermesRunRepositoryError('not_found', 'run not found');
		if (current.state !== 'queued' || current.leaseOwner || current.leaseToken) return current;
		const cursor = current.cursor + 1;
		await tx.insert(hermesRunEvents).values({
			runId: id,
			accountId: owner,
			cursor,
			eventType: 'run.failed',
			dataJson: JSON.stringify({ failure_class: failureClass, error: { message: safeError } }),
			createdAt: now
		});
		const [run] = (await tx
			.update(hermesRuns)
			.set({ state: 'failed', errorMessage: safeError, cursor, updatedAt: now, completedAt: now })
			.where(
				and(
					eq(hermesRuns.id, id),
					eq(hermesRuns.accountId, owner),
					eq(hermesRuns.state, 'queued'),
					isNull(hermesRuns.leaseOwner),
					isNull(hermesRuns.leaseToken)
				)
			)
			.returning()) as HermesRunRecord[];
		if (!run) {
			const [latest] = (await tx
				.select()
				.from(hermesRuns)
				.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
				.limit(1)) as HermesRunRecord[];
			if (!latest) throw new HermesRunRepositoryError('not_found', 'run disappeared during start failure');
			return latest;
		}
		const snapshot = snapshotFromRun(run);
		await tx
			.update(messages)
			.set({ content: snapshot.answerText, partial: 1, toolCalls: null })
			.where(and(eq(messages.id, current.assistantMessageId), eq(messages.conversationId, current.conversationId)));
		const provenance = buildAnswerProvenanceBundle({
			messageId: current.assistantMessageId,
			conversationId: current.conversationId,
			tools: [],
			sources: [],
			citations: [],
			answerText: snapshot.answerText,
			startedAt: current.startedAt ?? current.createdAt,
			endedAt: now,
			assistantChars: snapshot.answerText.length,
			done: false,
			finishStatus: 'failed',
			transport: 'hermes_durable'
		});
		await tx
			.insert(messageProvenance)
			.values({
				messageId: current.assistantMessageId,
				conversationId: current.conversationId,
				provenanceJson: JSON.stringify(provenance),
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: messageProvenance.messageId,
				set: { provenanceJson: JSON.stringify(provenance), updatedAt: now }
			});
		await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, current.conversationId));
		return run;
	});
}

export async function finalizeHermesRunCancellation(
	accountId: string,
	runId: string,
	reason = 'worker_not_running'
): Promise<HermesRunRecord> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(
			sql`SELECT id FROM hermes_runs WHERE id = ${id} AND account_id = ${owner} FOR UPDATE`
		);
		const [current] = (await tx
			.select()
			.from(hermesRuns)
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.limit(1)) as HermesRunRecord[];
		if (!current) throw new HermesRunRepositoryError('not_found', 'run not found');
		if (isTerminal(normalizeState(current.state))) return current;
		if (normalizeState(current.state) !== 'cancel_requested') {
			throw new HermesRunRepositoryError('invalid_input', 'run is not waiting for cancellation');
		}
		const cursor = current.cursor + 1;
		await tx.insert(hermesRunEvents).values({
			runId: id,
			accountId: owner,
			cursor,
			eventType: 'run.cancelled',
			dataJson: JSON.stringify({ status: 'cancelled', reason }),
			createdAt: now
		});
		const [run] = (await tx
			.update(hermesRuns)
			.set({
				state: 'cancelled',
				cursor,
				updatedAt: now,
				completedAt: now,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null
			})
			.where(and(eq(hermesRuns.id, id), eq(hermesRuns.accountId, owner)))
			.returning()) as HermesRunRecord[];
		if (!run) throw new HermesRunRepositoryError('not_found', 'run disappeared during cancellation');
		const snapshot = snapshotFromRun(run);
		await tx
			.update(messages)
			.set({
				content: snapshot.answerText,
				partial: 1,
				toolCalls: serializeToolMetadata(snapshot.tools, snapshot.sources, snapshot.citations)
			})
			.where(and(eq(messages.id, current.assistantMessageId), eq(messages.conversationId, current.conversationId)));
		const provenance = buildAnswerProvenanceBundle({
			messageId: current.assistantMessageId,
			conversationId: current.conversationId,
			tools: snapshot.tools,
			sources: snapshot.sources,
			citations: snapshot.citations,
			answerText: snapshot.answerText,
			startedAt: run.startedAt ?? current.createdAt,
			endedAt: now,
			assistantChars: snapshot.answerText.length,
			done: false,
			finishStatus: 'cancelled',
			transport: 'hermes_durable'
		});
		await tx
			.insert(messageProvenance)
			.values({
				messageId: current.assistantMessageId,
				conversationId: current.conversationId,
				provenanceJson: JSON.stringify(provenance),
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: messageProvenance.messageId,
				set: { provenanceJson: JSON.stringify(provenance), updatedAt: now }
			});
		await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, current.conversationId));
		return run;
	});
}

export async function claimHermesRunLease(
	accountId: string,
	runId: string,
	leaseOwner: string,
	now = Date.now()
): Promise<HermesRunRecord | null> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const worker = requireValue(leaseOwner, 'leaseOwner');
	const leaseToken = randomUUID();
	const [run] = (await db
		.update(hermesRuns)
		.set({
			leaseOwner: worker,
			leaseToken,
			leaseExpiresAt: now + HERMES_LEASE_MS,
			state: 'researching',
			startedAt: sql`COALESCE(${hermesRuns.startedAt}, ${now})`,
			updatedAt: now
		})
		.where(
			and(
				eq(hermesRuns.id, id),
				eq(hermesRuns.accountId, owner),
				isNull(hermesRuns.cancelRequestedAt),
				inArray(hermesRuns.state, HERMES_ACTIVE_STATES),
				or(isNull(hermesRuns.leaseExpiresAt), lt(hermesRuns.leaseExpiresAt, now))
			)
		)
		.returning()) as HermesRunRecord[];
	return run || null;
}

export async function renewHermesRunLease(
	accountId: string,
	runId: string,
	leaseOwner: string,
	leaseToken: string,
	now = Date.now()
): Promise<HermesRunRecord> {
	const [run] = (await db
		.update(hermesRuns)
		.set({ leaseExpiresAt: now + HERMES_LEASE_MS, updatedAt: now })
		.where(
			and(
				eq(hermesRuns.id, requireValue(runId, 'runId')),
				eq(hermesRuns.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRuns.leaseOwner, requireValue(leaseOwner, 'leaseOwner')),
				eq(hermesRuns.leaseToken, requireValue(leaseToken, 'leaseToken')),
				inArray(hermesRuns.state, HERMES_ACTIVE_STATES),
				gt(hermesRuns.leaseExpiresAt, now)
			)
		)
		.returning()) as HermesRunRecord[];
	if (!run) throw new HermesRunRepositoryError('stale_lease', 'run lease is stale');
	return run;
}

export async function releaseHermesRunLease(
	accountId: string,
	runId: string,
	leaseOwner: string,
	leaseToken: string
): Promise<HermesRunRecord> {
	const [run] = (await db
		.update(hermesRuns)
		.set({ state: 'queued', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: Date.now() })
		.where(
			and(
				eq(hermesRuns.id, requireValue(runId, 'runId')),
				eq(hermesRuns.accountId, requireValue(accountId, 'accountId')),
				eq(hermesRuns.leaseOwner, requireValue(leaseOwner, 'leaseOwner')),
				eq(hermesRuns.leaseToken, requireValue(leaseToken, 'leaseToken')),
				inArray(hermesRuns.state, HERMES_ACTIVE_STATES),
				isNull(hermesRuns.cancelRequestedAt)
			)
		)
		.returning()) as HermesRunRecord[];
	if (!run) throw new HermesRunRepositoryError('stale_lease', 'run lease is stale');
	return run;
}

export async function reclaimQueuedOrExpiredHermesRuns(
	leaseOwner: string,
	limit = 10,
	now = Date.now()
): Promise<HermesRunRecord[]> {
	const worker = requireValue(leaseOwner, 'leaseOwner');
	const boundedLimit = Math.min(Math.max(limit, 1), 50);
	const activeStates = sql.join(HERMES_ACTIVE_STATES.map((state) => sql`${state}`), sql`, `);
	const candidates = Array.from(
		(await db.execute(sql`
			SELECT account_id AS "accountId", id
			FROM (
				SELECT
					account_id,
					id,
					tenant_key,
					created_at,
					ROW_NUMBER() OVER (
						PARTITION BY tenant_key
						ORDER BY created_at ASC, id ASC
					) AS tenant_rank
				FROM hermes_runs
				WHERE cancel_requested_at IS NULL
					AND state IN (${activeStates})
					AND (lease_expires_at IS NULL OR lease_expires_at < ${now})
			) eligible
			ORDER BY tenant_rank ASC, created_at ASC, id ASC
			LIMIT ${boundedLimit}
		`)) as Iterable<{ accountId: string; id: string }>
	);
	const claimed: HermesRunRecord[] = [];
	for (const candidate of candidates) {
		const run = await claimHermesRunLease(candidate.accountId, candidate.id, worker, now);
		if (run) claimed.push(run);
	}
	return claimed;
}
