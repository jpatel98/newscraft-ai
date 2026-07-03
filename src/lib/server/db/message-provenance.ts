import { eq } from 'drizzle-orm';
import { db } from './index';
import { messageProvenance } from './schema';

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
