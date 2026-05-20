import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { db } from './index';
import { conversations, messages } from './schema';
import { newId } from '$lib/utils/id';
import type { ContentPart, MessageContent } from '$lib/types';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

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
	const row: ConversationRow = {
		id: newId(),
		accountId,
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
		createdAt: now
	};
	await db.insert(messages).values(row);
	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, input.conversationId));
	return row;
}

export async function setConversationTitle(accountId: string, id: string, title: string): Promise<void> {
	await db
		.update(conversations)
		.set({ title })
		.where(and(eq(conversations.id, id), eq(conversations.accountId, accountId)));
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

export async function appendMessageContent(id: string, chunk: string): Promise<void> {
	if (!chunk) return;
	const row = await getMessageById(id);
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
	await db.update(messages).set({ content: serializeContent(next) }).where(eq(messages.id, id));
	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, row.conversationId));
}

export async function finalizeMessage(id: string): Promise<void> {
	await db.update(messages).set({ partial: 0 }).where(eq(messages.id, id));
}

export async function setMessageToolCalls(id: string, toolCalls: string | null): Promise<void> {
	await db.update(messages).set({ toolCalls }).where(eq(messages.id, id));
}

export async function clearMessagePartial(id: string): Promise<MessageRow | undefined> {
	await db.update(messages).set({ partial: 0 }).where(eq(messages.id, id));
	return getMessageById(id);
}

export async function lastUserMessage(conversationId: string): Promise<MessageRow | undefined> {
	const [row] = (await db
		.select()
		.from(messages)
		.where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
		.orderBy(desc(messages.createdAt))
		.limit(1)) as MessageRow[];
	return row;
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
