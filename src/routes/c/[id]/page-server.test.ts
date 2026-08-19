import { describe, expect, it, vi } from 'vitest';

const conversationMocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	getMessages: vi.fn(),
	parseContent: vi.fn((value: string) => value)
}));
const runMocks = vi.hoisted(() => ({
	getActiveHermesRun: vi.fn(),
	listHermesRunsForConversation: vi.fn(),
	snapshotFromRun: vi.fn(() => ({
		state: 'writing',
		answerText: 'Saved answer',
		sources: [{ id: 'source-1', url: 'https://example.test', title: 'Example', status: 'used', domain: 'example.test', firstSeenAt: 1, lastSeenAt: 1, used: true }],
		citations: [],
		tools: [],
		errorMessage: null
	}))
}));

vi.mock('$lib/server/db/conversations', () => conversationMocks);
vi.mock('$lib/server/db/hermes-runs', () => runMocks);

import { load } from './+page.server';

describe('conversation durable run load', () => {
	it('returns the account-scoped active run snapshot for refresh recovery', async () => {
		conversationMocks.getConversation.mockResolvedValue({ id: 'conversation-1', title: 'Thread', updatedAt: 7 });
		conversationMocks.getMessages.mockResolvedValue([]);
		runMocks.getActiveHermesRun.mockResolvedValue({
			id: 'run-1',
			conversationId: 'conversation-1',
			assistantMessageId: 'assistant-1',
			cursor: 4,
			state: 'writing'
		});
		runMocks.listHermesRunsForConversation.mockResolvedValue([]);

		const result = (await load({
			params: { id: 'conversation-1' },
			locals: { user: { id: 'account-1' } }
		} as any)) as any;

		expect(runMocks.getActiveHermesRun).toHaveBeenCalledWith('account-1', 'conversation-1');
		expect(result.durableRun).toMatchObject({
			id: 'run-1',
			conversationId: 'conversation-1',
			assistantMessageId: 'assistant-1',
			cursor: 4,
			status: 'writing',
			answerText: 'Saved answer'
		});
	});

	it('attaches the saved terminal run state to its assistant message', async () => {
		conversationMocks.getConversation.mockResolvedValue({ id: 'conversation-1', title: 'Thread', updatedAt: 7 });
		conversationMocks.getMessages.mockResolvedValue([
			{ id: 'assistant-1', role: 'assistant', content: 'Partial answer', toolCalls: null, partial: 1, createdAt: 6 }
		]);
		runMocks.getActiveHermesRun.mockResolvedValue(null);
		runMocks.listHermesRunsForConversation.mockResolvedValue([
			{ assistantMessageId: 'assistant-1', state: 'cancelled', errorMessage: null }
		]);

		const result = (await load({ params: { id: 'conversation-1' }, locals: { user: { id: 'account-1' } } } as any)) as any;
		expect(result.messages[0]).toMatchObject({ durableState: 'cancelled', durableError: null });
	});
});
