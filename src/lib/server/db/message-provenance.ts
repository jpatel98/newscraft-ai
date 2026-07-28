import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { messageProvenance } from './schema';

const DEFAULT_CONVERSATION_PROVENANCE_LIMIT = 24;

export interface MessageProvenanceRow {
	messageId: string;
	conversationId: string;
	provenanceJson: string;
	createdAt: number;
	updatedAt: number;
}

export async function saveMessageProvenance(input: {
	messageId: string;
	conversationId: string;
	provenanceJson: string;
	now?: number;
}): Promise<void> {
	const now = input.now ?? Date.now();
	await db
		.insert(messageProvenance)
		.values({
			messageId: input.messageId,
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
}

export async function getMessageProvenance(messageId: string): Promise<MessageProvenanceRow | undefined> {
	const [row] = (await db
		.select()
		.from(messageProvenance)
		.where(eq(messageProvenance.messageId, messageId))
		.limit(1)) as MessageProvenanceRow[];
	return row;
}

export async function getConversationMessageProvenance(
	conversationId: string,
	options: { messageIds?: string[]; limit?: number } = {}
): Promise<MessageProvenanceRow[]> {
	const messageIds = Array.from(new Set(options.messageIds ?? []));
	if (options.messageIds && !messageIds.length) return [];
	const limit = Math.max(
		1,
		Math.min(options.limit ?? DEFAULT_CONVERSATION_PROVENANCE_LIMIT, DEFAULT_CONVERSATION_PROVENANCE_LIMIT)
	);
	return (await db
		.select()
		.from(messageProvenance)
		.where(
			messageIds.length
				? and(
						eq(messageProvenance.conversationId, conversationId),
						inArray(messageProvenance.messageId, messageIds)
					)
				: eq(messageProvenance.conversationId, conversationId)
		)
		.orderBy(desc(messageProvenance.updatedAt))
		.limit(limit)) as MessageProvenanceRow[];
}
