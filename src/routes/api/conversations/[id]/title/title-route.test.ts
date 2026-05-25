import { beforeEach, describe, expect, it, vi } from 'vitest';

const titleMocks = vi.hoisted(() => ({
	generateConversationTitle: vi.fn()
}));

const conversationMocks = vi.hoisted(() => ({
	getConversation: vi.fn()
}));

vi.mock('$lib/server/conversation-title', () => titleMocks);
vi.mock('$lib/server/db/conversations', () => conversationMocks);

import { POST } from './+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

describe('conversation title retry route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects blank conversation ids', async () => {
		await expect(POST({ locals: { user }, params: { id: '   ' } } as any)).rejects.toMatchObject({
			status: 400
		});
		expect(titleMocks.generateConversationTitle).not.toHaveBeenCalled();
	});

	it('rejects retry when a conversation already has a title', async () => {
		conversationMocks.getConversation.mockResolvedValue({
			id: 'convo-1',
			title: 'Budget hearing recap',
			updatedAt: Date.now() - 120_000
		});

		await expect(POST({ locals: { user }, params: { id: 'convo-1' } } as any)).rejects.toMatchObject({
			status: 400
		});
		expect(titleMocks.generateConversationTitle).not.toHaveBeenCalled();
	});

	it('returns the generated title', async () => {
		conversationMocks.getConversation.mockResolvedValue({
			id: 'convo-1',
			title: '',
			updatedAt: Date.now() - 120_000
		});
		titleMocks.generateConversationTitle.mockResolvedValue({
			row: { id: 'convo-1', title: 'Budget hearing recap', updatedAt: 123 },
			title: 'Budget hearing recap',
			generated: true
		});

		const response = await POST({ locals: { user }, params: { id: 'convo-1' } } as any);

		expect(titleMocks.generateConversationTitle).toHaveBeenCalledWith('account-1', 'convo-1', {
			force: true
		});
		await expect(response.json()).resolves.toEqual({
			id: 'convo-1',
			title: 'Budget hearing recap',
			updatedAt: 123
		});
	});
});
