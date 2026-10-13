import type { CitationRecord } from '@newscraft/shared';
import { parseToolMetadata } from '$lib/utils/tool-metadata';

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

interface ThreadCitationMessage {
	role: string;
	partial?: number | boolean | null;
	toolCalls: string | null;
}

/**
 * Every citation recorded on a completed assistant answer in this thread, one
 * record per number. Seeding all of them keeps [n] meaning the same source for
 * the life of the thread: the worker numbers new pages after the highest one and
 * never reuses a number the ledger or an earlier answer still shows. Records
 * listed in `preferred` win; otherwise a newer answer's record wins a number.
 */
export function threadCitations(
	messages: ReadonlyArray<ThreadCitationMessage>,
	preferred: ReadonlyArray<CitationRecord> = []
): CitationRecord[] {
	const byNumber = new Map<number, CitationRecord>();
	for (const citation of preferred) {
		if (!byNumber.has(citation.citationNumber)) byNumber.set(citation.citationNumber, citation);
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'assistant' || message.partial) continue;
		for (const citation of parseToolMetadata(message.toolCalls).citations) {
			if (!byNumber.has(citation.citationNumber)) byNumber.set(citation.citationNumber, citation);
		}
	}
	return Array.from(byNumber.values()).sort((left, right) => left.citationNumber - right.citationNumber);
}
