import { and, asc, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import { db, ensureDefaultOrganizationForAccount } from './index';
import { conversations, messageProvenance, messages } from './schema';
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
