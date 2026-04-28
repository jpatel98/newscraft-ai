import { describe, expect, it } from 'vitest';
import { persistedThreadMessages } from './thread-messages';

describe('persistedThreadMessages', () => {
	it('preserves persisted tool-call metadata while hiding shadowed messages', () => {
		const messages = [
			{
				id: 'assistant-1',
				role: 'assistant' as const,
				content: 'Done',
				partial: false,
				createdAt: 1000,
				toolCalls: '[{"id":"tool-1","name":"terminal"}]'
			},
			{
				id: 'assistant-2',
				role: 'assistant' as const,
				content: 'Hidden partial',
				partial: true,
				createdAt: 2000,
				toolCalls: '[{"id":"tool-2","name":"web"}]'
			}
		];

		expect(persistedThreadMessages(messages, new Set(['assistant-2']))).toEqual([
			{
				id: 'assistant-1',
				role: 'assistant',
				content: 'Done',
				partial: false,
				createdAt: 1000,
				toolCalls: '[{"id":"tool-1","name":"terminal"}]'
			}
		]);
	});
});
