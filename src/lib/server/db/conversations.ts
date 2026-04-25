import { db } from './index';
import { conversations, messages } from './schema';
import { and, asc, desc, eq } from 'drizzle-orm';
import { newId } from '$lib/utils/id';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationRow {
	id: string;
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

export function listConversations(limit = 100): ConversationRow[] {
	return db.select().from(conversations).orderBy(desc(conversations.updatedAt)).limit(limit).all();
}

export function getConversation(id: string): ConversationRow | undefined {
	return db.select().from(conversations).where(eq(conversations.id, id)).get();
}

export function getMessages(conversationId: string): MessageRow[] {
	return db
		.select()
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(asc(messages.createdAt))
		.all() as MessageRow[];
}

export function createConversation(systemPrompt?: string): ConversationRow {
	const now = Date.now();
	const row: ConversationRow = {
		id: newId(),
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
	content: string;
	partial?: boolean;
	toolCalls?: string | null;
}): MessageRow {
	const now = Date.now();
	const row: MessageRow = {
		id: newId(),
		conversationId: input.conversationId,
		role: input.role,
		content: input.content,
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

export function setConversationTitle(id: string, title: string) {
	db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
}

export function deleteConversation(id: string) {
	db.delete(conversations).where(eq(conversations.id, id)).run();
}
