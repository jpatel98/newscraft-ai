import type { MessageRow } from '$lib/server/db/conversations';

export function answerForLatestUser(messages: MessageRow[]): MessageRow | undefined {
	const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
	if (lastUserIndex < 0) return undefined;
	return messages.slice(lastUserIndex + 1).find((message) => message.role === 'assistant');
}

export function isLatestUnfinishedAssistant(
	messages: MessageRow[],
	messageId: string
): boolean {
	const latest = messages.at(-1);
	return latest?.id === messageId && latest.role === 'assistant' && latest.partial === 1;
}
