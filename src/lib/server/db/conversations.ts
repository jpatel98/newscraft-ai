import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, ensureDefaultOrganizationForAccount } from './index';
import { conversations, hermesRuns, messageProvenance, messages } from './schema';
import { newId } from '$lib/utils/id';
import type { ContentPart, MessageContent } from '$lib/types';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

const PARTS_PREFIX = 'P:';

function serializeContent(c: MessageContent): string {
	if (typeof c === 'string') return c;
	return PARTS_PREFIX + JSON.stringify(c);
}

export function parseContent(stored: string): MessageContent {
	if (!stored.startsWith(PARTS_PREFIX)) return stored;
	try {
		const parsed = JSON.parse(stored.slice(PARTS_PREFIX.length)) as ContentPart[];
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* fall through */
	}
	return stored;
}

export interface ConversationRow {
	id: string;
	accountId: string;
	orgId: string | null;
	title: string;
	systemPrompt: string | null;
	createdAt: number;
	updatedAt: number;
	pinned: number;
}

export interface MessageRow {
	id: string;
	conversationId: string;
	role: Role;
	content: string;
	toolCalls: string | null;
	partial: number;
	resumeClaimedAt: number | null;
	createdAt: number;
}

export async function listConversations(accountId: string, limit = 100): Promise<ConversationRow[]> {
	return (await db
		.select()
		.from(conversations)
		.where(eq(conversations.accountId, accountId))
		.orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
		.limit(limit)) as ConversationRow[];
}

export async function getConversation(accountId: string, id: string): Promise<ConversationRow | undefined> {
	const [row] = (await db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.limit(1)) as ConversationRow[];
	return row;
}

export async function getMessages(conversationId: string): Promise<MessageRow[]> {
	return (await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt))) as MessageRow[];
}

export type ConversationActionSummary = {
	latestUser: MessageRow | null;
	latestAssistant: MessageRow | null;
	latestReadyAssistant: MessageRow | null;
	latestUnfinishedAssistant: MessageRow | null;
};

/** Read only the owner-scoped rows needed to decide latest-turn actions. */
export async function getConversationActionSummary(
	conversationId: string
): Promise<ConversationActionSummary> {
	const [latestUser, latestAssistant, latestReadyAssistant, latestUnfinishedAssistant] = await Promise.all([
		db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(1),
		db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(1),
		db
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.role, 'assistant'),
					eq(messages.partial, 0)
				)
			)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(1),
		db
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.role, 'assistant'),
					eq(messages.partial, 1)
				)
			)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(1)
	]);
	return {
		latestUser: (latestUser[0] as MessageRow | undefined) ?? null,
		latestAssistant: (latestAssistant[0] as MessageRow | undefined) ?? null,
		latestReadyAssistant: (latestReadyAssistant[0] as MessageRow | undefined) ?? null,
		latestUnfinishedAssistant: (latestUnfinishedAssistant[0] as MessageRow | undefined) ?? null
	};
}

export interface MessagePageCursor {
	createdAt: number;
	id: string;
}

/** Read the newest rows first, with one extra row for a stable older-page check. */
export async function getLatestMessagesPage(
	conversationId: string,
	limit: number
): Promise<MessageRow[]> {
	const rows = (await db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(limit + 1)) as MessageRow[];
	return rows.reverse();
}

/** Read the rows immediately before a cursor, with one extra row for pagination. */
export async function getMessagesBefore(
	conversationId: string,
	cursor: MessagePageCursor,
	limit: number
): Promise<MessageRow[]> {
	const rows = (await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				or(
					lt(messages.createdAt, cursor.createdAt),
					and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id))
				)
			)
		)
		.orderBy(desc(messages.createdAt), desc(messages.id))
		.limit(limit + 1)) as MessageRow[];
	return rows.reverse();
}

/** Read a bounded exclusive range between two owned cursors. */
export async function getMessagesBetween(
	conversationId: string,
	after: MessagePageCursor,
	before: MessagePageCursor,
	limit: number
): Promise<MessageRow[]> {
	return (await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, conversationId),
				or(
					gt(messages.createdAt, after.createdAt),
					and(eq(messages.createdAt, after.createdAt), gt(messages.id, after.id))
				),
				or(
					lt(messages.createdAt, before.createdAt),
					and(eq(messages.createdAt, before.createdAt), lt(messages.id, before.id))
				)
			)
		)
		.orderBy(asc(messages.createdAt), asc(messages.id))
		.limit(limit + 1)) as MessageRow[];
}

/** Read one target and bounded rows on both sides of it. */
export async function getMessageWindow(
	conversationId: string,
	target: MessagePageCursor,
	beforeLimit: number,
	afterLimit: number
): Promise<{ before: MessageRow[]; after: MessageRow[] }> {
	const conversationFilter = eq(messages.conversationId, conversationId);
	const [before, after] = await Promise.all([
		db
			.select()
			.from(messages)
			.where(
				and(
					conversationFilter,
					or(
						lt(messages.createdAt, target.createdAt),
						and(eq(messages.createdAt, target.createdAt), lt(messages.id, target.id))
					)
				)
			)
			.orderBy(desc(messages.createdAt), desc(messages.id))
			.limit(beforeLimit + 1),
		db
			.select()
			.from(messages)
			.where(
				and(
					conversationFilter,
					or(
						gt(messages.createdAt, target.createdAt),
						and(eq(messages.createdAt, target.createdAt), gt(messages.id, target.id))
					)
				)
			)
			.orderBy(asc(messages.createdAt), asc(messages.id))
			.limit(afterLimit + 1)
	]);
	return {
		before: (before as MessageRow[]).reverse(),
		after: after as MessageRow[]
	};
}

export async function getMessageCount(conversationId: string): Promise<number> {
	const [row] = (await db
		.select({ count: sql<number>`count(*)::int` })
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.limit(1)) as Array<{ count: number }>;
	return Number(row?.count ?? 0);
}

export async function getMessagesByIds(conversationId: string, ids: string[]): Promise<MessageRow[]> {
	const uniqueIds = Array.from(new Set(ids));
	if (uniqueIds.length === 0) return [];
	return (await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), inArray(messages.id, uniqueIds)))
		.orderBy(asc(messages.createdAt), asc(messages.id))) as MessageRow[];
}

/** Read one stable keyset page without changing the full-history getMessages API. */
export async function getMessagesBatch(
	conversationId: string,
	after: MessagePageCursor | null = null,
	limit = 16
): Promise<MessageRow[]> {
	const conversationFilter = eq(messages.conversationId, conversationId);
	const cursorFilter = after
		? or(
				gt(messages.createdAt, after.createdAt),
				and(eq(messages.createdAt, after.createdAt), gt(messages.id, after.id))
			)
		: undefined;
	const where = cursorFilter ? and(conversationFilter, cursorFilter) : conversationFilter;
	return (await db
		.select()
		.from(messages)
		.where(where)
		.orderBy(asc(messages.createdAt), asc(messages.id))
		.limit(limit)) as MessageRow[];
}

export async function createConversation(accountId: string, systemPrompt?: string): Promise<ConversationRow> {
	const now = Date.now();
	const orgId = await ensureDefaultOrganizationForAccount(accountId);
	const row: ConversationRow = {
		id: newId(),
		accountId,
		orgId,
		title: '',
		systemPrompt: systemPrompt ?? null,
		createdAt: now,
		updatedAt: now,
		pinned: 0
	};
	await db.insert(conversations).values(row);
	return row;
}

export async function addMessage(input: {
	conversationId: string;
	role: Role;
	content: MessageContent;
	partial?: boolean;
	toolCalls?: string | null;
}): Promise<MessageRow> {
	const now = Date.now();
	const row: MessageRow = {
		id: newId(),
		conversationId: input.conversationId,
		role: input.role,
		content: serializeContent(input.content),
		toolCalls: input.toolCalls ?? null,
		partial: input.partial ? 1 : 0,
		resumeClaimedAt: null,
		createdAt: now
	};
	await db.insert(messages).values(row);
	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, input.conversationId));
	return row;
}

const DURABLE_DUPLICATE_WINDOW_MS = 15_000;

/**
 * Create one durable user/assistant pair, or reuse the same pair for a
 * simultaneous identical submit from another tab. The conversation row lock
 * makes the check and both inserts one atomic turn boundary.
 */
export async function prepareDurableUserTurn(input: {
	accountId: string;
	conversationId: string;
	content: MessageContent;
	dedupeKey: string;
	toolCalls?: string | null;
	now?: number;
}): Promise<{ user: MessageRow; assistant: MessageRow; created: boolean; claimToken: number }> {
	const now = input.now ?? Date.now();
	const serialized = serializeContent(input.content);
	const parsedToolCalls = (() => {
		try {
			const value = input.toolCalls ? JSON.parse(input.toolCalls) : {};
			return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		} catch {
			return {};
		}
	})();
	const preparedUserMetadata = JSON.stringify({
		...parsedToolCalls,
		durable_turn_key: input.dedupeKey.slice(0, 512)
	});
	return db.transaction(async (tx: any) => {
		const owned = await tx.execute(
			sql`SELECT id FROM conversations
				WHERE id = ${input.conversationId} AND account_id = ${input.accountId}
				FOR UPDATE`
		);
		if (!owned.length) throw new Error('conversation not found');

		const recent = (await tx
			.select()
			.from(messages)
			.where(eq(messages.conversationId, input.conversationId))
			.orderBy(desc(messages.createdAt))
			.limit(2)) as MessageRow[];
		const assistant = recent[0];
		const user = recent[1];
		if (
			assistant?.role === 'assistant' &&
			assistant.partial === 1 &&
			user?.role === 'user' &&
			user.content === serialized &&
			user.toolCalls === preparedUserMetadata &&
			now - user.createdAt <= DURABLE_DUPLICATE_WINDOW_MS
		) {
			const [run] = await tx
				.select({ state: hermesRuns.state })
				.from(hermesRuns)
				.where(
					and(
						eq(hermesRuns.accountId, input.accountId),
						eq(hermesRuns.conversationId, input.conversationId),
						eq(hermesRuns.assistantMessageId, assistant.id)
					)
				)
				.orderBy(desc(hermesRuns.createdAt))
				.limit(1);
			if (!run || ['queued', 'researching', 'writing', 'reconnecting', 'cancel_requested'].includes(run.state)) {
				return { user, assistant, created: false, claimToken: assistant.resumeClaimedAt ?? assistant.createdAt };
			}
		}

		const userRow: MessageRow = {
			id: newId(),
			conversationId: input.conversationId,
			role: 'user',
			content: serialized,
			toolCalls: preparedUserMetadata,
			partial: 0,
			resumeClaimedAt: null,
			createdAt: now
		};
		const assistantRow: MessageRow = {
			id: newId(),
			conversationId: input.conversationId,
			role: 'assistant',
			content: '',
			toolCalls: null,
			partial: 1,
			resumeClaimedAt: now + 1,
			createdAt: now + 1
		};
		await tx.insert(messages).values([userRow, assistantRow]);
		await tx
			.update(conversations)
			.set({ updatedAt: now + 1 })
			.where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
		return { user: userRow, assistant: assistantRow, created: true, claimToken: now + 1 };
	});
}

export async function takeOverPreparedDurableTurn(input: {
	accountId: string;
	conversationId: string;
	messageId: string;
	staleBefore: number;
	now?: number;
}): Promise<number | null> {
	const now = input.now ?? Date.now();
	return db.transaction(async (tx: any) => {
		await tx.execute(
			sql`SELECT messages.id FROM messages
				JOIN conversations ON conversations.id = messages.conversation_id
				WHERE messages.id = ${input.messageId}
					AND messages.conversation_id = ${input.conversationId}
					AND conversations.account_id = ${input.accountId}
				FOR UPDATE OF messages`
		);
		const [activeRun] = await tx
			.select({ id: hermesRuns.id })
			.from(hermesRuns)
			.where(
				and(
					eq(hermesRuns.accountId, input.accountId),
					eq(hermesRuns.conversationId, input.conversationId),
					eq(hermesRuns.assistantMessageId, input.messageId)
				)
			)
			.limit(1);
		if (activeRun) return null;
		const [current] = (await tx
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.id, input.messageId),
					eq(messages.conversationId, input.conversationId),
					eq(messages.role, 'assistant'),
					eq(messages.partial, 1)
				)
			)
			.limit(1)) as MessageRow[];
		if (!current || current.resumeClaimedAt == null || current.resumeClaimedAt > input.staleBefore) {
			return null;
		}
		const claimToken = Math.max(now, current.resumeClaimedAt + 1);
		const [claimed] = (await tx
			.update(messages)
			.set({ resumeClaimedAt: claimToken })
			.where(
				and(
					eq(messages.id, input.messageId),
					eq(messages.conversationId, input.conversationId),
					eq(messages.resumeClaimedAt, current.resumeClaimedAt)
				)
			)
			.returning()) as MessageRow[];
		return claimed ? claimToken : null;
	});
}

export async function getPreparedDurableTurnStatus(
	accountId: string,
	conversationId: string,
	messageId: string
): Promise<{ runId: string | null; partial: number; content: string } | null> {
	const [row] = await db
		.select({
			runId: hermesRuns.id,
			partial: messages.partial,
			content: messages.content
		})
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.leftJoin(
			hermesRuns,
			and(
				eq(hermesRuns.accountId, accountId),
				eq(hermesRuns.conversationId, conversationId),
				eq(hermesRuns.assistantMessageId, messageId)
			)
		)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.conversationId, conversationId),
				eq(conversations.accountId, accountId)
			)
		)
		.orderBy(desc(hermesRuns.createdAt))
		.limit(1);
	return row ?? null;
}

export async function finalizePreparedAssistantMessage(input: {
	accountId: string;
	conversationId: string;
	messageId: string;
	claimToken: number;
	content: MessageContent;
	now?: number;
}): Promise<MessageRow | undefined> {
	const now = input.now ?? Date.now();
	return db.transaction(async (tx: any) => {
		const owned = await tx.execute(
			sql`SELECT messages.id FROM messages
				JOIN conversations ON conversations.id = messages.conversation_id
				WHERE messages.id = ${input.messageId}
					AND messages.conversation_id = ${input.conversationId}
					AND conversations.account_id = ${input.accountId}
				FOR UPDATE OF messages`
		);
		if (!owned.length) return undefined;
		const [row] = (await tx
			.update(messages)
			.set({
				content: serializeContent(input.content),
				toolCalls: null,
				partial: 0,
				resumeClaimedAt: null
			})
			.where(
				and(
					eq(messages.id, input.messageId),
					eq(messages.conversationId, input.conversationId),
					eq(messages.role, 'assistant'),
					eq(messages.partial, 1),
					eq(messages.resumeClaimedAt, input.claimToken)
				)
			)
			.returning()) as MessageRow[];
		if (!row) return undefined;
		await tx
			.update(conversations)
			.set({ updatedAt: now })
			.where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
		return row;
	});
}

export async function setConversationTitle(
	accountId: string,
	id: string,
	title: string
): Promise<ConversationRow | undefined> {
	await db
		.update(conversations)
		.set({ title })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)));
	return getConversation(accountId, id);
}

export async function setConversationTitleIfCurrent(
	accountId: string,
	id: string,
	currentTitle: string,
	title: string
): Promise<ConversationRow | undefined> {
	const [row] = (await db
		.update(conversations)
		.set({ title })
		.where(
			and(
				eq(conversations.id, id),
				eq(conversations.accountId, accountId),
				eq(conversations.title, currentTitle)
			)
		)
		.returning()) as ConversationRow[];
	return row;
}

export async function renameConversation(
	accountId: string,
	id: string,
	title: string
): Promise<ConversationRow | undefined> {
	const now = Date.now();
	await db
		.update(conversations)
		.set({ title, updatedAt: now })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)));
	return getConversation(accountId, id);
}

export async function setConversationPinned(
	accountId: string,
	id: string,
	pinned: 0 | 1
): Promise<ConversationRow | undefined> {
	await db
		.update(conversations)
		.set({ pinned })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)));
	return getConversation(accountId, id);
}

export async function setConversationSystemPrompt(
	accountId: string,
	id: string,
	prompt: string | null
): Promise<ConversationRow | undefined> {
	const trimmed = prompt == null ? null : prompt.trim() || null;
	const now = Date.now();
	await db
		.update(conversations)
		.set({ systemPrompt: trimmed, updatedAt: now })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)));
	return getConversation(accountId, id);
}

export async function deleteConversation(accountId: string, id: string): Promise<void> {
	await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)));
}

export async function deleteMessagesFrom(conversationId: string, messageId: string): Promise<number> {
	const [target] = (await db.select().from(messages).where(eq(messages.id, messageId)).limit(1)) as MessageRow[];
	if (!target || target.conversationId !== conversationId) return 0;
	await db
		.delete(messages)
		.where(and(eq(messages.conversationId, conversationId), gte(messages.createdAt, target.createdAt)));
	return 1;
}

export async function getMessageById(id: string): Promise<MessageRow | undefined> {
	const [row] = (await db.select().from(messages).where(eq(messages.id, id)).limit(1)) as MessageRow[];
	return row;
}

/**
 * Atomically commits every resumed assistant route. The claim token and
 * partial predicate form the compare-and-set contract: a stale retry cannot
 * append, replace, finalize, or rewrite provenance after another owner wins.
 */
export async function finalizeResumedAssistantMessage(input: {
	id: string;
	conversationId: string;
	claimToken: number;
	mode: 'append' | 'replace' | 'discard';
	content?: MessageContent;
	appendContent?: string;
	toolCalls: string | null;
	provenanceJson: string;
	partial: 0 | 1;
	now?: number;
}): Promise<MessageRow | undefined> {
	const now = input.now ?? Date.now();
	return db.transaction(async (tx: any) => {
		const [current] = (await tx
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.id, input.id),
					eq(messages.conversationId, input.conversationId),
					eq(messages.role, 'assistant'),
					eq(messages.partial, 1),
					eq(messages.resumeClaimedAt, input.claimToken)
				)
			)
			.limit(1)) as MessageRow[];
		if (!current) return undefined;
		if (input.mode === 'replace' && input.content === undefined) {
			throw new Error('replacement content is required for resumed assistant finalization');
		}
		const nextContent =
			input.mode === 'replace'
				? input.content!
				: input.mode === 'append'
					? appendMessageContentValue(parseContent(current.content), input.appendContent || '')
					: parseContent(current.content);
		const committed = (await tx
			.update(messages)
			.set({
				content: serializeContent(nextContent),
				toolCalls: input.toolCalls,
				partial: input.partial,
				resumeClaimedAt: null
			})
			.where(
				and(
					eq(messages.id, input.id),
					eq(messages.conversationId, input.conversationId),
					eq(messages.role, 'assistant'),
					eq(messages.partial, 1),
					eq(messages.resumeClaimedAt, input.claimToken)
				)
			)
			.returning()) as MessageRow[];
		if (!committed.length) return undefined;

		await tx
			.insert(messageProvenance)
			.values({
				messageId: input.id,
				conversationId: input.conversationId,
				provenanceJson: input.provenanceJson,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: messageProvenance.messageId,
				set: {
					conversationId: input.conversationId,
					provenanceJson: input.provenanceJson,
					updatedAt: now
				}
			});
		await tx.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, input.conversationId));
		return committed[0];
	});
}

function appendMessageContentValue(current: MessageContent, chunk: string): MessageContent {
	if (!chunk) return current;
	if (typeof current === 'string') return current + chunk;
	const parts = [...current];
	const last = parts[parts.length - 1];
	if (last && last.type === 'text') {
		parts[parts.length - 1] = { type: 'text', text: last.text + chunk };
	} else {
		parts.push({ type: 'text', text: chunk });
	}
	return parts;
}

/**
 * Discards a partial row only for its current owner. This delegates to the
 * same transaction as append/replace finalization so metadata and provenance
 * cannot be committed independently of clearing the claim.
 */
export async function discardPartialAssistantMessage(input: {
	id: string;
	conversationId: string;
	claimToken: number;
	toolCalls: string | null;
	provenanceJson: string;
	now?: number;
}): Promise<MessageRow | undefined> {
	return finalizeResumedAssistantMessage({
		...input,
		mode: 'discard',
		partial: 0
	});
}

const RESUME_CLAIM_TTL_MS = 5 * 60 * 1000;

export async function claimPartialAssistantMessage(id: string, conversationId: string): Promise<number | null> {
	const now = Date.now();
	const cutoff = now - RESUME_CLAIM_TTL_MS;
	const claimed = await db
		.update(messages)
		.set({ resumeClaimedAt: now })
		.where(
			and(
				eq(messages.id, id),
				eq(messages.conversationId, conversationId),
				eq(messages.role, 'assistant'),
				eq(messages.partial, 1),
				or(isNull(messages.resumeClaimedAt), lt(messages.resumeClaimedAt, cutoff))
			)
		)
		.returning({ claimToken: messages.resumeClaimedAt });
	return claimed[0]?.claimToken ?? null;
}

export async function lastAssistantMessage(conversationId: string): Promise<MessageRow | undefined> {
	const [row] = (await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
		.orderBy(desc(messages.createdAt))
		.limit(1)) as MessageRow[];
	return row;
}
