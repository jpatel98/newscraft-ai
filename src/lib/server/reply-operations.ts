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

export function resumeContinuationInstruction(partialAnswer: string): string {
	return [
		'The previous Hermes run disconnected before it finished.',
		'Continue the same request without repeating research that is already represented in the conversation context and source history.',
		'Return one complete final answer. Do not repeat planning or tool narration from the partial draft.',
		partialAnswer.trim() ? `Partial draft to replace, not append:\n\n${partialAnswer.trim()}` : ''
	]
		.filter(Boolean)
		.join('\n\n');
}
