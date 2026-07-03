import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from './index';
import { chatDiagnostics } from './schema';
import type { ChatDiagnosticEvent } from '$lib/server/chat-diagnostics';

const PERSISTED_DIAGNOSTIC_LIMIT = 120;
const PERSISTED_DIAGNOSTIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type ChatDiagnosticRow = typeof chatDiagnostics.$inferSelect;

export async function saveChatDiagnostic(event: ChatDiagnosticEvent): Promise<void> {
	await db.insert(chatDiagnostics).values({
		id: event.id,
		conversationId: event.conversationId,
		type: event.type,
		detailsJson: JSON.stringify(event.details),
		createdAt: event.createdAt
	});
}

export async function listPersistedChatDiagnostics(conversationId: string): Promise<ChatDiagnosticEvent[]> {
	const cutoff = Date.now() - PERSISTED_DIAGNOSTIC_TTL_MS;
	const rows = await db
		.select()
		.from(chatDiagnostics)
		.where(andConversationSince(conversationId, cutoff))
		.orderBy(desc(chatDiagnostics.createdAt))
		.limit(PERSISTED_DIAGNOSTIC_LIMIT);

	return (rows as ChatDiagnosticRow[]).reverse().map((row) => ({
		id: row.id,
		conversationId: row.conversationId,
		type: row.type,
		createdAt: row.createdAt,
		details: parseDetails(row.detailsJson)
	}));
}

function andConversationSince(conversationId: string, cutoff: number) {
	return and(eq(chatDiagnostics.conversationId, conversationId), gte(chatDiagnostics.createdAt, cutoff));
}

function parseDetails(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
