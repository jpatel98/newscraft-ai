import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './index';
import { retryRead } from './read-retry';
import { conversations, agentRunArtifactRefs, agentRunEvents, agentRuns, messages, messageProvenance } from './schema';
import { newId } from '$lib/utils/id';
import { splitLedgerBlock, stripLedgerForDisplay, type LedgerClaim } from '$lib/utils/story-ledger';
import { upsertStoryClaims } from './story-claims';
import { citationSources } from '$lib/utils/claim-evidence';
import { workerClaimJudge } from '../ledger-judge';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import {
	serializeToolMetadata,
	buildAnswerProvenanceBundle,
	citationRecordsUsedInAnswer
} from '$lib/utils/tool-metadata';
import { sanitizeUnresolvedCitationMarkers, truncateReadableAnswer } from '$lib/utils/stream-events';
import {
	normalizePublicAgentDecision,
	normalizePublicAgentPlan,
	type CitationRecord,
	type PublicAgentDecision,
	type PublicAgentPlan
} from '@newscraft/shared';
import type { PersistedSource, StreamToolCall } from '$lib/utils/stream-events';

export type AgentRunState =
	| 'queued'
	| 'researching'
	| 'writing'
	| 'reconnecting'
	| 'cancel_requested'
	| 'cancelled'
	| 'failed'
	| 'complete';

export const AGENT_ACTIVE_STATES: AgentRunState[] = [
	'queued',
	'researching',
	'writing',
	'reconnecting',
	'cancel_requested'
];

export const AGENT_TERMINAL_STATES: AgentRunState[] = ['cancelled', 'failed', 'complete'];
export const AGENT_LEASE_MS = 90_000;
export const AGENT_RECOVERY_GRACE_MS = 45_000;
export const AGENT_MAX_EVENT_BYTES = 128 * 1024;
// Input may include image data and conversation history. Match the portable
// worker's 512 KiB input bound without increasing any public event limit.
export const AGENT_MAX_INPUT_BYTES = 512 * 1024;
export const AGENT_MAX_ANSWER_CHARS = 512 * 1024;
export const AGENT_MAX_SNAPSHOT_ITEMS = 100;
export const AGENT_MAX_ACTIVITY_DECISIONS = 50;

export interface AgentRunEventInput {
	eventType: string;
	dataJson: string;
	workerCursor: number;
	/** Ready artifact revision to reference at this exact event cursor. */
	artifactRevisionId?: string | null;
}

export interface AgentRunCreateInput {
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
	/** Existing partial answer from an account-bound resume target. */
	seededAnswerText?: string;
}

export type AgentRunRecord = typeof agentRuns.$inferSelect;
export type AgentRunEventRecord = typeof agentRunEvents.$inferSelect;
export type AgentRunEventRead = Pick<
	AgentRunEventRecord,
	'cursor' | 'eventType' | 'dataJson' | 'createdAt'
>;
export type AgentRunSubscriptionEvent = Pick<
	AgentRunEventRecord,
	'cursor' | 'eventType' | 'dataJson'
>;
export type AgentRunSubscriptionState = Pick<AgentRunRecord, 'state' | 'cursor'>;
export type AgentRunMessageState = Pick<
	AgentRunRecord,
	'assistantMessageId' | 'state' | 'errorMessage'
>;

export class AgentRunRepositoryError extends Error {
	readonly code:
		| 'invalid_input'
		| 'not_found'
		| 'cross_account'
		| 'stale_lease'
		| 'stale_callback'
		| 'cancel_requested'
		| 'terminal';

	constructor(
		code: AgentRunRepositoryError['code'],
		message: string
	) {
		super(message);
		this.name = 'AgentRunRepositoryError';
		this.code = code;
	}
}

function requireValue(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new AgentRunRepositoryError('invalid_input', `${label} is required`);
	return normalized;
}

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function boundedJson(value: string, label: string, maxBytes = AGENT_MAX_EVENT_BYTES): string {
	if (Buffer.byteLength(value, 'utf8') > maxBytes) {
		throw new AgentRunRepositoryError('invalid_input', `${label} is too large`);
	}
	return value;
}

function normalizeState(value: string | null | undefined): AgentRunState {
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

function isTerminal(state: AgentRunState): boolean {
	return AGENT_TERMINAL_STATES.includes(state);
}

function nextState(
	current: AgentRunState,
	eventType: string,
	data: Record<string, unknown>
): AgentRunState {
	if (eventType === 'run.cancelled' || eventType === 'cancelled') return 'cancelled';
	if (eventType === 'run.failed' || eventType === 'response.failed') return 'failed';
	if (eventType === 'response.completed' || eventType === 'run.complete' || eventType === 'run.finished') {
		return 'complete';
	}
	if (eventType === 'run.reconnecting') return 'reconnecting';
	if (eventType === 'response.output_text.delta' || eventType === 'agent.answer.replace') return 'writing';
	if (eventType === 'agent.tool.progress' || eventType.startsWith('agent.source') ||
		eventType === 'agent.citations' || eventType === 'agent.plan' || eventType === 'agent.decision') {
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

export interface AgentRunSnapshot {
	state: AgentRunState;
	answerText: string;
	sources: PersistedSource[];
	citations: CitationRecord[];
	tools: StreamToolCall[];
	plan?: PublicAgentPlan;
	decisions?: PublicAgentDecision[];
	errorMessage: string | null;
}

export function snapshotFromRun(run: AgentRunRecord): AgentRunSnapshot {
	// Existing rows contain a plain tool array. Public activity uses an
	// envelope in the same column so old runs need no data migration.
	const toolData = parseJson<unknown>(run.toolsJson, []);
	const activity = objectValue(toolData);
	const plan = normalizePublicAgentPlan(activity?.plan);
	const decisions = Array.isArray(activity?.decisions)
		? activity.decisions
				.map(normalizePublicAgentDecision)
				.filter((decision): decision is PublicAgentDecision => decision !== null)
				.slice(-AGENT_MAX_ACTIVITY_DECISIONS)
		: [];
	return {
		state: normalizeState(run.state),
		answerText: run.answerText,
		sources: parseJson<PersistedSource[]>(run.sourcesJson, []),
		citations: parseJson<CitationRecord[]>(run.citationsJson, []),
		tools: Array.isArray(toolData)
			? toolData as StreamToolCall[]
			: Array.isArray(activity?.tools) ? activity.tools as StreamToolCall[] : [],
		...(plan ? { plan } : {}),
		...(decisions.length ? { decisions } : {}),
		errorMessage: run.errorMessage
	};
}

function serializeRunActivity(snapshot: AgentRunSnapshot): string {
	return snapshot.plan || snapshot.decisions?.length
		? JSON.stringify({ version: 1, tools: snapshot.tools,
			...(snapshot.plan ? { plan: snapshot.plan } : {}),
			...(snapshot.decisions?.length ? { decisions: snapshot.decisions } : {}) })
		: JSON.stringify(snapshot.tools);
}

/** Keep the durable event log on the same public schema as its projection. */
function publicActivityData(eventType: string, dataJson: string): string {
	if (/(?:^|[._-])(?:reasoning|thinking|chain_of_thought)(?:[._-]|$)/iu.test(eventType)) {
		throw new AgentRunRepositoryError('invalid_input', 'private reasoning events are not accepted');
	}
	if (eventType !== 'agent.plan' && eventType !== 'agent.decision') return dataJson;
	const data = parseJson<unknown>(dataJson, null);
	const activity = eventType === 'agent.plan'
		? normalizePublicAgentPlan(data)
		: normalizePublicAgentDecision(data);
	if (!activity) throw new AgentRunRepositoryError('invalid_input', 'public activity payload is invalid');
	return JSON.stringify(activity);
}

function applyAgentRunEventData(
	run: AgentRunRecord,
	eventType: string,
	data: Record<string, unknown>
): AgentRunSnapshot {
	const snapshot = snapshotFromRun(run);
	const plan = eventType === 'agent.plan'
		? normalizePublicAgentPlan(data) || snapshot.plan
		: snapshot.plan;
	const decisions = [...(snapshot.decisions || [])];
	if (eventType === 'agent.decision') {
		const decision = normalizePublicAgentDecision(data);
		if (decision) {
			const index = decisions.findIndex((item) => item.id === decision.id);
			if (index >= 0) decisions[index] = decision;
			else decisions.push(decision);
		}
	}
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
		? truncateReadableAnswer(answerText, AGENT_MAX_ANSWER_CHARS, true)
		: answerText.slice(0, AGENT_MAX_ANSWER_CHARS);

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
		sources: sources.slice(-AGENT_MAX_SNAPSHOT_ITEMS),
		citations: citations.slice(-AGENT_MAX_SNAPSHOT_ITEMS),
		tools: tools.slice(-AGENT_MAX_SNAPSHOT_ITEMS),
		...(plan ? { plan } : {}),
		...(decisions.length ? { decisions: decisions.slice(-AGENT_MAX_ACTIVITY_DECISIONS) } : {}),
		errorMessage:
			eventType === 'response.failed' || eventType === 'run.failed'
				? stringValue(objectValue(data.error)?.message) || stringValue(data.message) || 'Agent run failed.'
				: snapshot.errorMessage
	};
}

export function applyAgentRunEvent(
	run: AgentRunRecord,
	eventType: string,
	dataJson: string
): AgentRunSnapshot {
	return applyAgentRunEventData(run, eventType, objectValue(parseJson<unknown>(dataJson, {})) || {});
}

export async function createOrGetAgentRun(
	input: AgentRunCreateInput
): Promise<{ run: AgentRunRecord; created: boolean }> {
	const accountId = requireValue(input.accountId, 'accountId');
	const conversationId = requireValue(input.conversationId, 'conversationId');
	const assistantMessageId = requireValue(input.assistantMessageId, 'assistantMessageId');
	const idempotencyKey = requireValue(input.idempotencyKey, 'idempotencyKey');
	const tenantKey = requireValue(input.tenantKey, 'tenantKey');
	const sessionId = requireValue(input.sessionId, 'sessionId');
	const inputJson = boundedJson(input.inputJson, 'inputJson', AGENT_MAX_INPUT_BYTES);
	const seededCitationsJson = boundedJson(input.seededCitationsJson || '[]', 'seededCitationsJson');
	const seededAnswerText = (input.seededAnswerText ?? '').slice(0, AGENT_MAX_ANSWER_CHARS);
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
			throw new AgentRunRepositoryError('not_found', 'assistant message is not owned by account');
		}
		if (input.userMessageId) {
			const boundUser = await tx.execute(
				sql`SELECT messages.id FROM messages
					JOIN conversations ON conversations.id = messages.conversation_id
					WHERE messages.id = ${input.userMessageId}
						AND messages.conversation_id = ${conversationId}
						AND conversations.account_id = ${accountId}`
			);
			if (!boundUser.length) throw new AgentRunRepositoryError('not_found', 'user message is not owned by account');
		}
		const [active] = (await tx
			.select()
			.from(agentRuns)
			.where(
				and(
					eq(agentRuns.accountId, accountId),
					eq(agentRuns.conversationId, conversationId),
					eq(agentRuns.assistantMessageId, assistantMessageId),
					inArray(agentRuns.state, AGENT_ACTIVE_STATES)
				)
			)
			.orderBy(desc(agentRuns.updatedAt))
			.limit(1)) as AgentRunRecord[];
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
				throw new AgentRunRepositoryError('stale_callback', 'prepared turn ownership is stale');
			}
		}

		const [inserted] = await tx
			.insert(agentRuns)
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
				answerText: seededAnswerText,
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
			.onConflictDoNothing({ target: [agentRuns.accountId, agentRuns.idempotencyKey] })
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
			.from(agentRuns)
			.where(and(eq(agentRuns.accountId, accountId), eq(agentRuns.idempotencyKey, idempotencyKey)))
			.limit(1)) as AgentRunRecord[];
		if (!existing) throw new AgentRunRepositoryError('not_found', 'run disappeared after idempotent insert');
		// Route preflight is only an optimization: another conversation can win
		// this account-scoped key while the current request is preparing its turn.
		if (existing.conversationId !== conversationId) {
			throw new AgentRunRepositoryError('invalid_input', 'idempotency key belongs to another conversation');
		}
		return { run: existing, created: false };
	});
}

/**
 * Create one stable assistant placeholder for an idempotent durable turn.
 * The account and conversation check is part of this operation. This keeps
 * duplicate browser submissions from creating duplicate assistant rows.
 */
export async function ensureAgentAssistantMessage(
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
	if (!ownedConversation) throw new AgentRunRepositoryError('cross_account', 'conversation is not owned by account');
	const id = `agent-assistant-${createHash('sha256')
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

export async function getAgentRun(
	accountId: string,
	value: string,
	by: 'id' | 'idempotency' = 'id'
): Promise<AgentRunRecord | null> {
	const owner = requireValue(accountId, 'accountId');
	const key = requireValue(value, by === 'id' ? 'runId' : 'idempotencyKey');
	const rows = await db
		.select()
		.from(agentRuns)
		.where(and(eq(agentRuns.accountId, owner), by === 'id' ? eq(agentRuns.id, key) : eq(agentRuns.idempotencyKey, key)))
		.limit(1);
	return (rows[0] as AgentRunRecord | undefined) || null;
}

/** Read only the fields needed by a live subscription poll. */
export async function getAgentRunSubscriptionState(
	accountId: string,
	runId: string
): Promise<AgentRunSubscriptionState | null> {
	const rows = await db
		.select({ state: agentRuns.state, cursor: agentRuns.cursor })
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.accountId, requireValue(accountId, 'accountId')),
				eq(agentRuns.id, requireValue(runId, 'runId'))
			)
		)
		.limit(1);
	return (rows[0] as AgentRunSubscriptionState | undefined) || null;
}

export async function getAgentRunForAssistant(
	accountId: string,
	conversationId: string,
	assistantMessageId: string
): Promise<AgentRunRecord | null> {
	const rows = await db
		.select()
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.accountId, requireValue(accountId, 'accountId')),
				eq(agentRuns.conversationId, requireValue(conversationId, 'conversationId')),
				eq(agentRuns.assistantMessageId, requireValue(assistantMessageId, 'assistantMessageId')),
				inArray(agentRuns.state, AGENT_ACTIVE_STATES)
			)
		)
		.orderBy(desc(agentRuns.updatedAt))
		.limit(1);
	return (rows[0] as AgentRunRecord | undefined) || null;
}

export async function getActiveAgentRun(
	accountId: string,
	conversationId: string
): Promise<AgentRunRecord | null> {
	const rows = await db
		.select()
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.accountId, requireValue(accountId, 'accountId')),
				eq(agentRuns.conversationId, requireValue(conversationId, 'conversationId')),
				inArray(agentRuns.state, AGENT_ACTIVE_STATES)
			)
		)
		.orderBy(desc(agentRuns.updatedAt))
		.limit(1);
	return (rows[0] as AgentRunRecord | undefined) || null;
}

export async function listAgentRunsForConversation(
	accountId: string,
	conversationId: string
): Promise<AgentRunMessageState[]> {
	const owner = requireValue(accountId, 'accountId');
	const conversation = requireValue(conversationId, 'conversationId');
	return (await db
		.select({
			assistantMessageId: agentRuns.assistantMessageId,
			state: agentRuns.state,
			errorMessage: agentRuns.errorMessage
		})
		.from(agentRuns)
		.where(and(eq(agentRuns.accountId, owner), eq(agentRuns.conversationId, conversation)))
		.orderBy(desc(agentRuns.createdAt))
		.limit(500)) as AgentRunMessageState[];
}

/** Read the newest durable state for the explicitly requested assistant ids. */
export async function listAgentRunStatesForMessages(
	accountId: string,
	conversationId: string,
	messageIds: string[]
): Promise<AgentRunMessageState[]> {
	const owner = requireValue(accountId, 'accountId');
	const conversation = requireValue(conversationId, 'conversationId');
	const ids = Array.from(new Set(messageIds.map((id) => id.trim()).filter(Boolean)));
	if (ids.length === 0) return [];
	const rows = (await db
		.select({
			assistantMessageId: agentRuns.assistantMessageId,
			state: agentRuns.state,
			errorMessage: agentRuns.errorMessage,
			createdAt: agentRuns.createdAt,
			id: agentRuns.id
		})
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.accountId, owner),
				eq(agentRuns.conversationId, conversation),
				inArray(agentRuns.assistantMessageId, ids)
			)
		)
		.orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))) as Array<
		Pick<AgentRunRecord, 'assistantMessageId' | 'state' | 'errorMessage' | 'createdAt' | 'id'>
	>;
	const latest = new Map<string, AgentRunMessageState>();
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

export async function listAgentRunEvents(
	accountId: string,
	runId: string,
	afterCursor = 0,
	limit = 500
): Promise<AgentRunEventRead[]> {
	if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
		throw new AgentRunRepositoryError('invalid_input', 'afterCursor must be a non-negative integer');
	}
	const run = await getAgentRun(accountId, runId);
	if (!run) throw new AgentRunRepositoryError('not_found', 'run not found');
	return (await db
		.select({
			cursor: agentRunEvents.cursor,
			eventType: agentRunEvents.eventType,
			dataJson: agentRunEvents.dataJson,
			createdAt: agentRunEvents.createdAt
		})
		.from(agentRunEvents)
		.where(
			and(
				eq(agentRunEvents.accountId, requireValue(accountId, 'accountId')),
				eq(agentRunEvents.runId, run.id),
				gt(agentRunEvents.cursor, afterCursor)
			)
		)
		.orderBy(asc(agentRunEvents.cursor))
		.limit(Math.min(Math.max(limit, 1), 1000))) as AgentRunEventRead[];
}

/**
 * List events after the caller has already verified the tenant-bound run.
 * Both account and run remain part of the query boundary.
 */
export async function listKnownAgentRunEvents(
	accountId: string,
	runId: string,
	afterCursor = 0,
	limit = 500
): Promise<AgentRunSubscriptionEvent[]> {
	if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
		throw new AgentRunRepositoryError('invalid_input', 'afterCursor must be a non-negative integer');
	}
	return (await db
		.select({
			cursor: agentRunEvents.cursor,
			eventType: agentRunEvents.eventType,
			dataJson: agentRunEvents.dataJson
		})
		.from(agentRunEvents)
		.where(
			and(
				eq(agentRunEvents.accountId, requireValue(accountId, 'accountId')),
				eq(agentRunEvents.runId, requireValue(runId, 'runId')),
				gt(agentRunEvents.cursor, afterCursor)
			)
		)
		.orderBy(asc(agentRunEvents.cursor))
		.limit(Math.min(Math.max(limit, 1), 1000))) as AgentRunSubscriptionEvent[];
}

/**
 * Remove the worker's story-ledger block from an `agent.answer.replace`
 * payload. Returns null when the payload has no block, so ordinary events keep
 * their exact bytes (replay detection compares stored bytes).
 */
function stripLedgerFromAnswerEvent(
	dataJson: string
): { dataJson: string; claims: LedgerClaim[] | null } | null {
	const data = objectValue(parseJson<unknown>(dataJson, null));
	if (!data || typeof data.content !== 'string') return null;
	const split = splitLedgerBlock(data.content);
	if (!split.found) return null;
	return { dataJson: JSON.stringify({ ...data, content: split.visible }), claims: split.claims };
}

/** Persist ledger claims after the run transaction; a ledger failure never fails the run. */
async function saveLedgerClaims(
	conversationId: string,
	messageId: string,
	claims: LedgerClaim[] | null,
	citations: readonly CitationRecord[]
): Promise<void> {
	if (!claims?.length) return;
	try {
		await upsertStoryClaims(conversationId, messageId, claims, Date.now(), workerClaimJudge, citationSources(citations));
	} catch (cause) {
		recordChatDiagnostic(conversationId, 'chat.story_ledger_error', {
			errorName: cause instanceof Error ? cause.name : 'Error',
			claimCount: claims.length
		});
	}
}

export async function appendAgentRunEvent(
	accountId: string, runId: string, leaseOwner: string, leaseToken: string, input: AgentRunEventInput
): Promise<{ run: AgentRunRecord; event: AgentRunEventRecord }> {
	return appendAgentRunEvents(accountId, runId, leaseOwner, leaseToken, [input]);
}

export async function appendAgentRunEvents(
	accountId: string,
	runId: string,
	leaseOwner: string,
	leaseToken: string,
	inputs: AgentRunEventInput[]
): Promise<{ run: AgentRunRecord; event: AgentRunEventRecord }> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const worker = requireValue(leaseOwner, 'leaseOwner');
	const token = requireValue(leaseToken, 'leaseToken');
	if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32) {
		throw new AgentRunRepositoryError('invalid_input', 'callback batch must contain 1 to 32 events');
	}
	let ledgerClaims: LedgerClaim[] | null = null;
	const validated = inputs.map((input, index) => {
		if (!Number.isSafeInteger(input.workerCursor) || input.workerCursor < 1 ||
			(index > 0 && input.workerCursor !== inputs[index - 1].workerCursor + 1)) {
			throw new AgentRunRepositoryError('invalid_input', 'batch worker cursors must be consecutive positive integers');
		}
		const eventType = requireValue(input.eventType, 'eventType');
		let dataJson = publicActivityData(eventType, boundedJson(input.dataJson, 'event data'));
		if (eventType === 'agent.answer.replace') {
			// The worker's story-ledger block is machine-only. Strip it before the
			// event is stored or replayed so no consumer can show it.
			const stripped = stripLedgerFromAnswerEvent(dataJson);
			if (stripped) {
				dataJson = stripped.dataJson;
				if (stripped.claims) ledgerClaims = stripped.claims;
			}
		}
		return { ...input, eventType, dataJson };
	});
	if (validated.reduce((size, input) => size + Buffer.byteLength(input.dataJson), 0) > 512 * 1024) {
		throw new AgentRunRepositoryError('invalid_input', 'callback batch exceeds 512 KiB');
	}
	const now = Date.now();
	let replayed = false;
	let ledgerConversationId = '';
	let ledgerMessageId = '';
	let terminalLedgerClaims: LedgerClaim[] | null = null;
	// The run's citations as of this batch: what the ledger block's [n] numbers point at.
	let ledgerCitations: CitationRecord[] = [];

	const appended = await db.transaction(async (tx: any) => {
		const [current] = (await tx
			.select()
			.from(agentRuns)
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.for('update')
			.limit(1)) as AgentRunRecord[];
		if (!current) throw new AgentRunRepositoryError('not_found', 'run not found');
		if (current.leaseOwner !== worker || current.leaseToken !== token) {
			throw new AgentRunRepositoryError('stale_lease', 'run lease is stale');
		}
		ledgerConversationId = current.conversationId;
		ledgerMessageId = current.assistantMessageId;
		const lastInput = validated[validated.length - 1];
		// Whole batches commit atomically. A lost acknowledgment can replay the
		// exact last batch, including completion, without applying it twice.
		if (lastInput.workerCursor === current.workerCursor && current.cursor >= validated.length) {
			const previous = await tx.select().from(agentRunEvents)
				.where(and(eq(agentRunEvents.runId, id), eq(agentRunEvents.accountId, owner),
					ne(agentRunEvents.eventType, 'run.cancel_requested')))
				.orderBy(desc(agentRunEvents.cursor)).limit(validated.length);
			previous.reverse();
			if (previous.length === validated.length && previous.every((event: AgentRunEventRecord, index: number) =>
				event.eventType === validated[index].eventType && event.dataJson === validated[index].dataJson)) {
				replayed = true;
				return { run: current, event: previous[previous.length - 1] };
			}
			throw new AgentRunRepositoryError('stale_callback', 'callback replay differs from saved events');
		}
		if (!current.leaseExpiresAt || current.leaseExpiresAt <= now) {
			throw new AgentRunRepositoryError('stale_lease', 'run lease is stale');
		}
		let working = current;
		let snapshot = snapshotFromRun(current);
		let sourceEvent = false, citationEvent = false, toolEvent = false, activityEvent = false, answerEvent = false;
		const eventRows: typeof agentRunEvents.$inferInsert[] = [];
		const artifactRefs: Array<{ revisionId: string; cursor: number }> = [];
		for (const input of validated) {
			const { eventType, dataJson } = input;
			const state = normalizeState(working.state);
			if (isTerminal(state)) throw new AgentRunRepositoryError('terminal', 'run is already terminal');
			if (state === 'cancel_requested' && eventType !== 'run.cancelled' && eventType !== 'cancelled') {
				throw new AgentRunRepositoryError('stale_callback', 'callbacks after cancellation are not accepted');
			}
			if (input.workerCursor !== (working.workerCursor || 0) + 1) {
				throw new AgentRunRepositoryError('stale_callback', 'run callback cursor is not monotonic');
			}

			const eventData = objectValue(parseJson<unknown>(dataJson, {})) || {};
			const artifactRevisionId = typeof input.artifactRevisionId === 'string' ? input.artifactRevisionId.trim() : '';
			const payloadArtifactRevisionId = typeof eventData.artifact_revision_id === 'string'
				? eventData.artifact_revision_id.trim()
				: '';
			if (eventType === 'artifact.ready' && (!artifactRevisionId || payloadArtifactRevisionId !== artifactRevisionId)) {
				throw new AgentRunRepositoryError('invalid_input', 'artifact.ready must identify the referenced revision');
			}
			if (eventType !== 'artifact.ready' && payloadArtifactRevisionId) {
				throw new AgentRunRepositoryError('invalid_input', 'artifact revision is only valid on artifact.ready');
			}
			if (artifactRevisionId && eventType !== 'artifact.ready') {
				throw new AgentRunRepositoryError('invalid_input', 'artifact reference is only valid on artifact.ready');
			}
			if (artifactRevisionId) {
				const artifactPayload = objectValue(eventData.artifact);
				const nestedRevisionId = typeof artifactPayload?.revisionId === 'string'
					? artifactPayload.revisionId.trim()
					: typeof artifactPayload?.revision_id === 'string'
						? artifactPayload.revision_id.trim()
						: '';
				if (nestedRevisionId && nestedRevisionId !== artifactRevisionId) {
					throw new AgentRunRepositoryError('invalid_input', 'artifact.ready summary does not match its revision');
				}
				const [artifact] = await tx.execute(sql`
					SELECT r.id, r.revision, r.status, f.id AS family_id, f.kind, f.title, f.source_message_id
					FROM artifact_revisions r
					JOIN artifact_families f ON f.id = r.family_id
					WHERE r.id = ${artifactRevisionId}
						AND r.status = 'ready'
						AND f.account_id = ${owner}
						AND f.conversation_id = ${current.conversationId}
						AND f.source_message_id = ${current.assistantMessageId}
					FOR UPDATE OF r, f
				`);
				if (!artifact) throw new AgentRunRepositoryError('stale_callback', 'artifact is not ready or not bound to this run');
				if (artifactPayload) {
					const nestedKind = typeof artifactPayload.kind === 'string' ? artifactPayload.kind.trim() : '';
					const nestedStatus = typeof artifactPayload.status === 'string' ? artifactPayload.status.trim() : '';
					const nestedId = typeof artifactPayload.id === 'string' ? artifactPayload.id.trim() : '';
					const nestedTitle = typeof artifactPayload.title === 'string' ? artifactPayload.title.trim() : '';
					const nestedSourceMessageId = typeof (artifactPayload.sourceMessageId ?? artifactPayload.source_message_id) === 'string'
						? String(artifactPayload.sourceMessageId ?? artifactPayload.source_message_id).trim()
						: '';
					const nestedRevision = typeof artifactPayload.revision === 'number' ? artifactPayload.revision : undefined;
					if (nestedKind && !['chart', 'table', 'image', 'markdown', 'map'].includes(nestedKind)) {
						throw new AgentRunRepositoryError('invalid_input', 'artifact.ready kind is invalid');
					}
					if (nestedStatus && nestedStatus !== 'ready') {
						throw new AgentRunRepositoryError('invalid_input', 'artifact.ready status is invalid');
					}
					if (
						(nestedId && nestedId !== artifact.family_id) ||
						(nestedKind && nestedKind !== artifact.kind) ||
						(nestedTitle && nestedTitle !== artifact.title) ||
						(nestedSourceMessageId && nestedSourceMessageId !== artifact.source_message_id) ||
						(nestedRevision !== undefined && (!Number.isSafeInteger(nestedRevision) || nestedRevision !== Number(artifact.revision)))
					) {
						throw new AgentRunRepositoryError('invalid_input', 'artifact.ready summary does not match its revision');
					}
				}
			}
			const nextSnapshot = applyAgentRunEventData(working, eventType, eventData);
			// Before completion trims citations to those the visible answer uses: the
			// ledger block may cite a page the prose does not.
			ledgerCitations = nextSnapshot.citations;
			const completedCitations =
				nextSnapshot.state === 'complete'
					? citationRecordsUsedInAnswer(nextSnapshot.answerText, nextSnapshot.citations)
					: nextSnapshot.citations;
			snapshot =
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
			const cursor = working.cursor + 1;
			eventRows.push({ runId: id, accountId: owner, cursor, eventType, dataJson, createdAt: now });
			if (artifactRevisionId) artifactRefs.push({ revisionId: artifactRevisionId, cursor });
			sourceEvent ||= Boolean(objectValue(eventData.source)) || eventType.startsWith('agent.source');
			citationEvent ||= Array.isArray(eventData.citations) || snapshot.state === 'complete';
			toolEvent ||= eventType === 'agent.tool.progress';
			activityEvent ||= eventType === 'agent.plan' || eventType === 'agent.decision';
			answerEvent ||= eventType === 'agent.answer.replace';
			working = { ...working, cursor, workerCursor: input.workerCursor, state: snapshot.state,
				answerText: snapshot.answerText, errorMessage: snapshot.errorMessage,
				sourcesJson: JSON.stringify(snapshot.sources), citationsJson: JSON.stringify(snapshot.citations),
				toolsJson: serializeRunActivity(snapshot) };
		}
		if (isTerminal(snapshot.state)) {
			// Streamed-delta runs carry the block inside the accumulated text; the
			// authoritative replace event was already stripped above.
			const split = splitLedgerBlock(snapshot.answerText);
			if (split.found) {
				snapshot = { ...snapshot, answerText: split.visible };
				working = { ...working, answerText: split.visible };
				if (snapshot.state === 'complete' && split.claims) terminalLedgerClaims = split.claims;
			}
		}
		const inserted = await tx.insert(agentRunEvents).values(eventRows).returning() as AgentRunEventRecord[];
		const event = inserted.find((row) => row.cursor === working.cursor);
		if (!event) throw new Error('Agent run event insert returned no row');
		for (const ref of artifactRefs) {
			await tx.insert(agentRunArtifactRefs).values({ runId: id, revisionId: ref.revisionId, cursor: ref.cursor, createdAt: now })
				.onConflictDoUpdate({ target: [agentRunArtifactRefs.runId, agentRunArtifactRefs.revisionId],
					set: { cursor: sql`GREATEST(${agentRunArtifactRefs.cursor}, EXCLUDED.cursor)`, createdAt: now } });
		}
		const terminal = isTerminal(snapshot.state);
		// The run row and event log are the live durable snapshot. Avoid rewriting
		// the message, provenance, and conversation rows for every ordinary text
		// delta; those projections still update on the first event, metadata
		// changes, answer replacement, and every terminal event.
		const persistMessageSnapshot =
			current.cursor === 0 || sourceEvent || citationEvent || toolEvent || activityEvent || answerEvent || terminal;
		const runUpdate: Partial<typeof agentRuns.$inferInsert> = {
			cursor: working.cursor,
			workerCursor: working.workerCursor,
			updatedAt: now,
			leaseExpiresAt: terminal ? null : now + AGENT_LEASE_MS
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
		if (toolEvent || activityEvent) {
			const toolsJson = serializeRunActivity(snapshot);
			if (toolsJson !== current.toolsJson) runUpdate.toolsJson = toolsJson;
		}
		const [run] = (await tx
			.update(agentRuns)
			.set(runUpdate)
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.returning()) as AgentRunRecord[];
		if (!run) throw new AgentRunRepositoryError('not_found', 'run disappeared during event append');

		if (persistMessageSnapshot) {
			// A still-streaming ledger fence must not reach the stored message.
			const displayText = terminal ? snapshot.answerText : stripLedgerForDisplay(snapshot.answerText);
			const messageUpdate: Partial<typeof messages.$inferInsert> = {
				content: displayText,
				partial: terminal && snapshot.state === 'complete' ? 0 : 1
			};
			// The first callback establishes metadata for the placeholder. Later
			// text-only callbacks cannot change sources, citations, or tools.
			if (current.cursor === 0 || sourceEvent || citationEvent || toolEvent || activityEvent || terminal) {
				messageUpdate.toolCalls = serializeToolMetadata(snapshot.tools, snapshot.sources, snapshot.citations,
					{ plan: snapshot.plan, decisions: snapshot.decisions });
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
				answerText: displayText,
				startedAt: run.startedAt ?? now,
				endedAt: terminal ? now : undefined,
				assistantChars: displayText.length,
				done: snapshot.state === 'complete',
				finishStatus: snapshot.state === 'complete' ? 'completed' : snapshot.state === 'cancelled' ? 'cancelled' : snapshot.state === 'failed' ? 'failed' : 'partial',
				transport: 'agent_durable'
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
		}
		return { run, event };
	});
	if (!replayed) {
		await saveLedgerClaims(ledgerConversationId, ledgerMessageId, terminalLedgerClaims ?? ledgerClaims, ledgerCitations);
	}
	return appended;
}

export async function requestAgentRunCancellation(
	accountId: string,
	runId: string,
	reason = 'user_requested'
): Promise<AgentRunRecord> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(
			sql`SELECT id FROM agent_runs WHERE id = ${id} AND account_id = ${owner} FOR UPDATE`
		);
		const [current] = (await tx
			.select()
			.from(agentRuns)
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.limit(1)) as AgentRunRecord[];
		if (!current) throw new AgentRunRepositoryError('not_found', 'run not found');
		if (isTerminal(normalizeState(current.state)) || normalizeState(current.state) === 'cancel_requested') return current;
		const cursor = current.cursor + 1;
		await tx.insert(agentRunEvents).values({
			runId: id,
			accountId: owner,
			cursor,
			eventType: 'run.cancel_requested',
			dataJson: JSON.stringify({ reason }),
			createdAt: now
		});
		const [run] = (await tx
			.update(agentRuns)
			.set({ state: 'cancel_requested', cancelRequestedAt: now, cursor, updatedAt: now })
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.returning()) as AgentRunRecord[];
		if (!run) throw new AgentRunRepositoryError('not_found', 'run disappeared during cancellation');
		return run;
	});
}

export async function failQueuedAgentRun(
	accountId: string,
	runId: string,
	errorMessage = 'Research service did not start. Try again.',
	failureClass: 'start' | 'overload' = 'start'
): Promise<AgentRunRecord> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const safeError = errorMessage.trim().slice(0, 2_000) || 'Research service did not start. Try again.';
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(sql`SELECT id FROM agent_runs WHERE id = ${id} AND account_id = ${owner} FOR UPDATE`);
		const [current] = (await tx
			.select()
			.from(agentRuns)
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.limit(1)) as AgentRunRecord[];
		if (!current) throw new AgentRunRepositoryError('not_found', 'run not found');
		if (current.state !== 'queued' || current.leaseOwner || current.leaseToken) return current;
		const cursor = current.cursor + 1;
		await tx.insert(agentRunEvents).values({
			runId: id,
			accountId: owner,
			cursor,
			eventType: 'run.failed',
			dataJson: JSON.stringify({ failure_class: failureClass, error: { message: safeError } }),
			createdAt: now
		});
		const [run] = (await tx
			.update(agentRuns)
			.set({ state: 'failed', errorMessage: safeError, cursor, updatedAt: now, completedAt: now })
			.where(
				and(
					eq(agentRuns.id, id),
					eq(agentRuns.accountId, owner),
					eq(agentRuns.state, 'queued'),
					isNull(agentRuns.leaseOwner),
					isNull(agentRuns.leaseToken)
				)
			)
			.returning()) as AgentRunRecord[];
		if (!run) {
			const [latest] = (await tx
				.select()
				.from(agentRuns)
				.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
				.limit(1)) as AgentRunRecord[];
			if (!latest) throw new AgentRunRepositoryError('not_found', 'run disappeared during start failure');
			return latest;
		}
		const snapshot = snapshotFromRun(run);
		await tx
			.update(messages)
			.set({
				content: stripLedgerForDisplay(snapshot.answerText),
				partial: 1,
				toolCalls: serializeToolMetadata(snapshot.tools, snapshot.sources, snapshot.citations,
					{ plan: snapshot.plan, decisions: snapshot.decisions })
			})
			.where(and(eq(messages.id, current.assistantMessageId), eq(messages.conversationId, current.conversationId)));
		const provenance = buildAnswerProvenanceBundle({
			messageId: current.assistantMessageId,
			conversationId: current.conversationId,
			tools: snapshot.tools,
			sources: snapshot.sources,
			citations: snapshot.citations,
			answerText: stripLedgerForDisplay(snapshot.answerText),
			startedAt: current.startedAt ?? current.createdAt,
			endedAt: now,
			assistantChars: stripLedgerForDisplay(snapshot.answerText).length,
			done: false,
			finishStatus: 'failed',
			transport: 'agent_durable'
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

export async function finalizeAgentRunCancellation(
	accountId: string,
	runId: string,
	reason = 'worker_not_running'
): Promise<AgentRunRecord> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const now = Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(
			sql`SELECT id FROM agent_runs WHERE id = ${id} AND account_id = ${owner} FOR UPDATE`
		);
		const [current] = (await tx
			.select()
			.from(agentRuns)
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.limit(1)) as AgentRunRecord[];
		if (!current) throw new AgentRunRepositoryError('not_found', 'run not found');
		if (isTerminal(normalizeState(current.state))) return current;
		if (normalizeState(current.state) !== 'cancel_requested') {
			throw new AgentRunRepositoryError('invalid_input', 'run is not waiting for cancellation');
		}
		const cursor = current.cursor + 1;
		await tx.insert(agentRunEvents).values({
			runId: id,
			accountId: owner,
			cursor,
			eventType: 'run.cancelled',
			dataJson: JSON.stringify({ status: 'cancelled', reason }),
			createdAt: now
		});
		const [run] = (await tx
			.update(agentRuns)
			.set({
				state: 'cancelled',
				cursor,
				updatedAt: now,
				completedAt: now,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null
			})
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.returning()) as AgentRunRecord[];
		if (!run) throw new AgentRunRepositoryError('not_found', 'run disappeared during cancellation');
		const snapshot = snapshotFromRun(run);
		await tx
			.update(messages)
			.set({
				content: stripLedgerForDisplay(snapshot.answerText),
				partial: 1,
				toolCalls: serializeToolMetadata(snapshot.tools, snapshot.sources, snapshot.citations,
					{ plan: snapshot.plan, decisions: snapshot.decisions })
			})
			.where(and(eq(messages.id, current.assistantMessageId), eq(messages.conversationId, current.conversationId)));
		const provenance = buildAnswerProvenanceBundle({
			messageId: current.assistantMessageId,
			conversationId: current.conversationId,
			tools: snapshot.tools,
			sources: snapshot.sources,
			citations: snapshot.citations,
			answerText: stripLedgerForDisplay(snapshot.answerText),
			startedAt: run.startedAt ?? current.createdAt,
			endedAt: now,
			assistantChars: stripLedgerForDisplay(snapshot.answerText).length,
			done: false,
			finishStatus: 'cancelled',
			transport: 'agent_durable'
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

/**
 * Close an active run whose expired worker lease has passed the recovery grace
 * before a browser subscription starts polling it. Workers can reclaim the run
 * immediately after expiry; this grace gives the periodic recovery loop time to
 * do so. The row lock plus owner/account predicates
 * make this a no-op for a lease that was renewed or replaced concurrently;
 * queued, unleased work remains available to the normal agent recovery loop.
 */
export async function reconcileExpiredAgentRun(
	accountId: string,
	runId: string,
	now = Date.now()
): Promise<AgentRunRecord | null> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const staleFailureMessage = 'Research stopped before it finished. Please try again.';
	const recoveryCutoff = now - AGENT_RECOVERY_GRACE_MS;
	return db.transaction(async (tx: any) => {
		const [current] = (await tx
			.select()
			.from(agentRuns)
			.where(and(eq(agentRuns.id, id), eq(agentRuns.accountId, owner)))
			.for('update')
			.limit(1)) as AgentRunRecord[];
		if (!current) return null;
		const currentState = normalizeState(current.state);
		if (
			currentState === 'queued' ||
			isTerminal(currentState) ||
			current.leaseOwner == null ||
			current.leaseToken == null ||
			current.leaseExpiresAt == null ||
			current.leaseExpiresAt > recoveryCutoff
		) {
			return current;
		}

        // Owned checkpoints retain uncertain request intents and completed
        // receipts. A recovering worker decides their outcome under a new lease.
        const [checkpoint] = await tx.execute(sql`SELECT run_id FROM agent_runtime_checkpoints
            WHERE run_id = ${id} AND account_id = ${owner}`);
        if (checkpoint) return current;

		const cancelled = currentState === 'cancel_requested' || current.cancelRequestedAt != null;
		const eventType = cancelled ? 'run.cancelled' : 'run.failed';
		const eventData = cancelled
			? { failure_class: 'cancelled', status: 'cancelled', reason: 'worker_lease_expired' }
			: { failure_class: 'timeout', reason: 'worker_lease_expired', error: { message: staleFailureMessage } };
		const cursor = current.cursor + 1;
		const [updated] = (await tx
			.update(agentRuns)
			.set({
				state: cancelled ? 'cancelled' : 'failed',
				...(cancelled ? {} : { errorMessage: staleFailureMessage }),
				cursor,
				updatedAt: now,
				completedAt: now,
				leaseOwner: null,
				leaseToken: null,
				leaseExpiresAt: null
			})
			.where(
				and(
					eq(agentRuns.id, id),
					eq(agentRuns.accountId, owner),
					eq(agentRuns.leaseOwner, current.leaseOwner),
					eq(agentRuns.leaseToken, current.leaseToken),
					lte(agentRuns.leaseExpiresAt, recoveryCutoff)
				)
			)
			.returning()) as AgentRunRecord[];
		if (!updated) throw new AgentRunRepositoryError('stale_lease', 'run lease changed during stale-run reconciliation');
		const [event] = (await tx
			.insert(agentRunEvents)
			.values({
				runId: id,
				accountId: owner,
				cursor,
				eventType,
				dataJson: JSON.stringify(eventData),
				createdAt: now
			})
			.returning()) as AgentRunEventRecord[];
		if (!event) throw new Error('Agent stale-run event insert returned no row');

		const snapshot = snapshotFromRun(updated);
		await tx
			.update(messages)
			.set({
				content: stripLedgerForDisplay(snapshot.answerText),
				partial: 1,
				toolCalls: serializeToolMetadata(snapshot.tools, snapshot.sources, snapshot.citations,
					{ plan: snapshot.plan, decisions: snapshot.decisions })
			})
			.where(and(eq(messages.id, updated.assistantMessageId), eq(messages.conversationId, updated.conversationId)));
		const provenance = buildAnswerProvenanceBundle({
			messageId: updated.assistantMessageId,
			conversationId: updated.conversationId,
			tools: snapshot.tools,
			sources: snapshot.sources,
			citations: snapshot.citations,
			answerText: stripLedgerForDisplay(snapshot.answerText),
			startedAt: updated.startedAt ?? current.createdAt,
			endedAt: now,
			assistantChars: stripLedgerForDisplay(snapshot.answerText).length,
			done: false,
			finishStatus: cancelled ? 'cancelled' : 'failed',
			transport: 'agent_durable'
		});
		const provenanceJson = JSON.stringify(provenance);
		await tx
			.insert(messageProvenance)
			.values({
				messageId: updated.assistantMessageId,
				conversationId: updated.conversationId,
				provenanceJson,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: messageProvenance.messageId,
				set: { provenanceJson, updatedAt: now }
			});
		await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, updated.conversationId));
		return updated;
	});
}

export async function claimAgentRunLease(
	accountId: string,
	runId: string,
	leaseOwner: string,
	now = Date.now()
): Promise<AgentRunRecord | null> {
	const owner = requireValue(accountId, 'accountId');
	const id = requireValue(runId, 'runId');
	const worker = requireValue(leaseOwner, 'leaseOwner');
	const leaseToken = randomUUID();
	const [run] = (await db
		.update(agentRuns)
		.set({
			leaseOwner: worker,
			leaseToken,
			leaseExpiresAt: now + AGENT_LEASE_MS,
			state: sql`CASE WHEN ${agentRuns.cancelRequestedAt} IS NOT NULL THEN 'cancel_requested' ELSE 'researching' END`,
			startedAt: sql`COALESCE(${agentRuns.startedAt}, ${now})`,
			updatedAt: now
		})
		.where(
			and(
				eq(agentRuns.id, id),
				eq(agentRuns.accountId, owner),
				inArray(agentRuns.state, AGENT_ACTIVE_STATES),
				or(isNull(agentRuns.leaseExpiresAt), lt(agentRuns.leaseExpiresAt, now))
			)
		)
		.returning()) as AgentRunRecord[];
	return run || null;
}

export async function renewAgentRunLease(
	accountId: string,
	runId: string,
	leaseOwner: string,
	leaseToken: string,
	now = Date.now()
): Promise<AgentRunRecord> {
	const [run] = (await db
		.update(agentRuns)
		.set({ leaseExpiresAt: now + AGENT_LEASE_MS, updatedAt: now })
		.where(
			and(
				eq(agentRuns.id, requireValue(runId, 'runId')),
				eq(agentRuns.accountId, requireValue(accountId, 'accountId')),
				eq(agentRuns.leaseOwner, requireValue(leaseOwner, 'leaseOwner')),
				eq(agentRuns.leaseToken, requireValue(leaseToken, 'leaseToken')),
				inArray(agentRuns.state, AGENT_ACTIVE_STATES),
				gt(agentRuns.leaseExpiresAt, now)
			)
		)
		.returning()) as AgentRunRecord[];
	if (!run) throw new AgentRunRepositoryError('stale_lease', 'run lease is stale');
	return run;
}

export async function releaseAgentRunLease(
	accountId: string,
	runId: string,
	leaseOwner: string,
	leaseToken: string
): Promise<AgentRunRecord> {
	const [run] = (await db
		.update(agentRuns)
		.set({ state: sql`CASE WHEN ${agentRuns.cancelRequestedAt} IS NOT NULL THEN 'cancel_requested' ELSE 'queued' END`, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: Date.now() })
		.where(
			and(
				eq(agentRuns.id, requireValue(runId, 'runId')),
				eq(agentRuns.accountId, requireValue(accountId, 'accountId')),
				eq(agentRuns.leaseOwner, requireValue(leaseOwner, 'leaseOwner')),
				eq(agentRuns.leaseToken, requireValue(leaseToken, 'leaseToken')),
				inArray(agentRuns.state, AGENT_ACTIVE_STATES)
			)
		)
		.returning()) as AgentRunRecord[];
	if (!run) throw new AgentRunRepositoryError('stale_lease', 'run lease is stale');
	return run;
}

export async function reclaimQueuedOrExpiredAgentRuns(
	leaseOwner: string,
	limit = 10,
	now = Date.now()
): Promise<AgentRunRecord[]> {
	const worker = requireValue(leaseOwner, 'leaseOwner');
	const boundedLimit = Math.min(Math.max(limit, 1), 50);
	const activeStates = sql.join(AGENT_ACTIVE_STATES.map((state) => sql`${state}`), sql`, `);
	// A read: the Vercel-to-Contabo TLS link sometimes resets mid-handshake, so retry once on a fresh connection.
	const candidates = Array.from(
		(await retryRead(() => db.execute(sql`
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
				FROM agent_runs
				WHERE state IN (${activeStates})
					AND (lease_expires_at IS NULL OR lease_expires_at < ${now})
			) eligible
			ORDER BY tenant_rank ASC, created_at ASC, id ASC
			LIMIT ${boundedLimit}
		`))) as Iterable<{ accountId: string; id: string }>
	);
	const claimed: AgentRunRecord[] = [];
	for (const candidate of candidates) {
		const run = await claimAgentRunLease(candidate.accountId, candidate.id, worker, now);
		if (run) claimed.push(run);
	}
	return claimed;
}
