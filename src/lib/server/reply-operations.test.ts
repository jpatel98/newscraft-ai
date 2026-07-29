import { describe, expect, it } from 'vitest';
import type { MessageRow } from '$lib/server/db/conversations';
import { answerForLatestUser, isLatestUnfinishedAssistant } from './reply-operations';

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
});
