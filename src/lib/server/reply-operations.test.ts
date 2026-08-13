import { describe, expect, it } from 'vitest';
import type { MessageRow } from '$lib/server/db/conversations';
import {
	answerForLatestUser,
	isLatestUnfinishedAssistant,
	resumeContinuationInstruction
} from './reply-operations';

function message(
	id: string,
	role: MessageRow['role'],
	partial = 0
): MessageRow {
	return {
		id,
		conversationId: 'conversation-1',
		role,
		content: id,
		toolCalls: null,
		partial,
		resumeClaimedAt: null,
		createdAt: Number(id.replace(/\D/g, '')) || 1
	};
}

describe('reply operations', () => {
	it('does not delete an older answer when the latest user has no answer yet', () => {
		const messages = [
			message('m1', 'user'),
			message('m2', 'assistant'),
			message('m3', 'user')
		];

		expect(answerForLatestUser(messages)).toBeUndefined();
	});

	it('targets only the answer paired with the latest user', () => {
		const messages = [
			message('m1', 'user'),
			message('m2', 'assistant'),
			message('m3', 'user'),
			message('m4', 'assistant')
		];

		expect(answerForLatestUser(messages)?.id).toBe('m4');
	});

	it('resumes only the latest unfinished assistant message', () => {
		const messages = [
			message('m1', 'user'),
			message('m2', 'assistant', 1),
			message('m3', 'user'),
			message('m4', 'assistant', 1)
		];

		expect(isLatestUnfinishedAssistant(messages, 'm2')).toBe(false);
		expect(isLatestUnfinishedAssistant(messages, 'm4')).toBe(true);
	});

	it('tells Hermes to replace an interrupted draft without repeating it', () => {
		const instruction = resumeContinuationInstruction('  Partial research text.  ');

		expect(instruction).toContain('Continue the same request');
		expect(instruction).toContain('Do not repeat planning or tool narration');
		expect(instruction).toContain('Partial draft to replace, not append:\n\nPartial research text.');
	});

	it('omits an empty partial draft from a continuation instruction', () => {
		const instruction = resumeContinuationInstruction('  ');

		expect(instruction).not.toContain('Partial draft to replace');
	});
});
