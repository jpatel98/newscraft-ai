interface CitationMessage {
	id: string;
	toolCalls: string | null;
}

export function selectCitationInheritanceToolCalls(input: {
	messages: ReadonlyArray<CitationMessage>;
	outputActionSourceToolCalls?: string | null;
	resumeMessageId?: string | null;
}): string | null {
	if (input.outputActionSourceToolCalls !== undefined) {
		return input.outputActionSourceToolCalls;
	}
	if (input.resumeMessageId) {
		return input.messages.find((message) => message.id === input.resumeMessageId)?.toolCalls ?? null;
	}
	return null;
}
