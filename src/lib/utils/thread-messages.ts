import type { ChatMessage } from '$lib/types';

export type PersistedThreadMessage = ChatMessage & { toolCalls?: string | null };

export function persistedThreadMessages(
	messages: PersistedThreadMessage[],
	hiddenIds: ReadonlySet<string>
): PersistedThreadMessage[] {
	return messages
		.filter((m) => !hiddenIds.has(m.id))
		.map<PersistedThreadMessage>((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			partial: m.partial,
			createdAt: m.createdAt,
			toolCalls: m.toolCalls
		}));
}
