import { db } from './index';
import { chatFeedback } from './schema';
import { newId } from '$lib/utils/id';
import type { ConversationRow, MessageRow } from './conversations';
import type { ChatDiagnosticEvent } from '$lib/server/chat-diagnostics';
import { eq } from 'drizzle-orm';

export interface ChatFeedbackRow {
	id: string;
	accountId: string;
	conversationId: string;
	comment: string;
	snapshotJson: string;
	linearIssueId: string | null;
	linearIssueIdentifier: string | null;
	linearIssueUrl: string | null;
	userAgent: string | null;
	createdAt: number;
}

export interface ChatFeedbackSnapshot {
	conversation: Pick<ConversationRow, 'id' | 'title' | 'systemPrompt' | 'createdAt' | 'updatedAt'>;
	messages: Array<
		Pick<MessageRow, 'id' | 'role' | 'content' | 'toolCalls' | 'partial' | 'createdAt'>
	>;
	diagnostics: ChatDiagnosticEvent[];
	capturedAt: number;
	messageCount: number;
}

export async function saveChatFeedback(input: {
	accountId: string;
	conversationId: string;
	comment: string;
	snapshot: ChatFeedbackSnapshot;
	userAgent?: string | null;
}): Promise<ChatFeedbackRow> {
	const now = Date.now();
	const row: ChatFeedbackRow = {
		id: newId(),
		accountId: input.accountId,
		conversationId: input.conversationId,
		comment: input.comment,
		snapshotJson: JSON.stringify(input.snapshot),
		linearIssueId: null,
		linearIssueIdentifier: null,
		linearIssueUrl: null,
		userAgent: input.userAgent ?? null,
		createdAt: now
	};
	await db.insert(chatFeedback).values(row);
	return row;
}

export async function attachLinearIssueToFeedback(input: {
	feedbackId: string;
	linearIssueId: string;
	linearIssueIdentifier: string;
	linearIssueUrl: string;
}): Promise<void> {
	await db
		.update(chatFeedback)
		.set({
			linearIssueId: input.linearIssueId,
			linearIssueIdentifier: input.linearIssueIdentifier,
			linearIssueUrl: input.linearIssueUrl
		})
		.where(eq(chatFeedback.id, input.feedbackId));
}
