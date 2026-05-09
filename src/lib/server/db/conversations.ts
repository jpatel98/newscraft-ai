import { db } from './index';
import { conversations, messages } from './schema';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { newId } from '$lib/utils/id';
import type { ContentPart, MessageContent } from '$lib/types';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Serialize a multimodal content value for the `text` content column.
 * Plain strings stay verbatim so existing rows keep their shape; arrays are
 * JSON-stringified with a leading sentinel so the read path can tell them
 * apart cheaply (avoids JSON.parse on every plain message).
 */
const PARTS_PREFIX = 'P:';

export function serializeContent(c: MessageContent): string {
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
	createdAt: number;
}

export function listConversations(accountId: string, limit = 100): ConversationRow[] {
	return db
		.select()
		.from(conversations)
		.where(eq(conversations.accountId, accountId))
		.orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
		.limit(limit)
		.all();
}

export function getConversation(accountId: string, id: string): ConversationRow | undefined {
	return db
		.select()
		.from(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.get();
}

export function getMessages(conversationId: string): MessageRow[] {
	return db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt))
		.all() as MessageRow[];
}

export function createConversation(accountId: string, systemPrompt?: string): ConversationRow {
	const now = Date.now();
	const row: ConversationRow = {
		id: newId(),
		accountId,
		title: '',
		systemPrompt: systemPrompt ?? null,
		createdAt: now,
		updatedAt: now,
		pinned: 0
	};
	db.insert(conversations).values(row).run();
	return row;
}

export function addMessage(input: {
	conversationId: string;
	role: Role;
	content: MessageContent;
	partial?: boolean;
	toolCalls?: string | null;
}): MessageRow {
	const now = Date.now();
	const row: MessageRow = {
		id: newId(),
		conversationId: input.conversationId,
		role: input.role,
		content: serializeContent(input.content),
		toolCalls: input.toolCalls ?? null,
		partial: input.partial ? 1 : 0,
		createdAt: now
	};
	db.insert(messages).values(row).run();
	db.update(conversations)
		.set({ updatedAt: now })
		.where(eq(conversations.id, input.conversationId))
		.run();
	return row;
}

export function setConversationTitle(accountId: string, id: string, title: string) {
	db.update(conversations)
		.set({ title })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.run();
}

export function renameConversation(accountId: string, id: string, title: string): ConversationRow | undefined {
	const now = Date.now();
	db.update(conversations)
		.set({ title, updatedAt: now })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.run();
	return getConversation(accountId, id);
}

export function setConversationPinned(accountId: string, id: string, pinned: 0 | 1): ConversationRow | undefined {
	db.update(conversations)
		.set({ pinned })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.run();
	return getConversation(accountId, id);
}

export function setConversationSystemPrompt(
	accountId: string,
	id: string,
	prompt: string | null
): ConversationRow | undefined {
	const trimmed = prompt == null ? null : prompt.trim() || null;
	const now = Date.now();
	db.update(conversations)
		.set({ systemPrompt: trimmed, updatedAt: now })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.run();
	return getConversation(accountId, id);
}

export function deleteConversation(accountId: string, id: string) {
	db.delete(conversations)
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)))
		.run();
}

/**
 * Delete a message and every message created after it in the same
 * conversation. Used by edit/regenerate to truncate the transcript before
 * re-streaming.
 */
export function deleteMessagesFrom(conversationId: string, messageId: string): number {
	const target = db.select().from(messages).where(eq(messages.id, messageId)).get() as
		| MessageRow
		| undefined;
	if (!target || target.conversationId !== conversationId) return 0;
	const result = db
		.delete(messages)
		.where(
			and(eq(messages.conversationId, conversationId), gte(messages.createdAt, target.createdAt))
		)
		.run();
	return result.changes ?? 0;
}

export function getMessageById(id: string): MessageRow | undefined {
	return db.select().from(messages).where(eq(messages.id, id)).get() as MessageRow | undefined;
}

/**
 * Append a text chunk to a message's stored content. Resume-after-disconnect
 * accumulates streamed deltas onto the existing partial assistant row instead
 * of inserting a new one. Plain-string content is concatenated directly;
 * arrays (multimodal) get the chunk pushed onto a trailing text part.
 */
export function appendMessageContent(id: string, chunk: string): void {
	if (!chunk) return;
	const row = getMessageById(id);
	if (!row) return;
	const parsed = parseContent(row.content);
	let next: MessageContent;
	if (typeof parsed === 'string') {
		next = parsed + chunk;
	} else {
		const parts = [...parsed];
		const last = parts[parts.length - 1];
		if (last && last.type === 'text') {
			parts[parts.length - 1] = { type: 'text', text: last.text + chunk };
		} else {
			parts.push({ type: 'text', text: chunk });
		}
		next = parts;
	}
	const now = Date.now();
	db.update(messages).set({ content: serializeContent(next) }).where(eq(messages.id, id)).run();
	db.update(conversations)
		.set({ updatedAt: now })
		.where(eq(conversations.id, row.conversationId))
		.run();
}

export function finalizeMessage(id: string): void {
	db.update(messages).set({ partial: 0 }).where(eq(messages.id, id)).run();
}

export function setMessageToolCalls(id: string, toolCalls: string | null): void {
	db.update(messages).set({ toolCalls }).where(eq(messages.id, id)).run();
}

export function clearMessagePartial(id: string): MessageRow | undefined {
	db.update(messages).set({ partial: 0 }).where(eq(messages.id, id)).run();
	return getMessageById(id);
}

export function lastUserMessage(conversationId: string): MessageRow | undefined {
	return db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
		.orderBy(desc(messages.createdAt))
		.limit(1)
		.get() as MessageRow | undefined;
}

export function lastAssistantMessage(conversationId: string): MessageRow | undefined {
	return db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
		.orderBy(desc(messages.createdAt))
		.limit(1)
		.get() as MessageRow | undefined;
}
