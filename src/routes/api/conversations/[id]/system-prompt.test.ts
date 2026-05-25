import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversationMocks = vi.hoisted(() => ({
	deleteConversation: vi.fn(),
	getConversation: vi.fn(),
	renameConversation: vi.fn(),
	setConversationPinned: vi.fn(),
	setConversationSystemPrompt: vi.fn()
}));

vi.mock('$lib/server/db/conversations', () => conversationMocks);

import { PATCH } from './+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };
const conversation = {
	id: 'conversation-1',
	accountId: user.id,
	title: 'Story',
	systemPrompt: null,
	createdAt: 1,
	updatedAt: 1,
	pinned: 0
};

function patch(systemPrompt: unknown) {
	return PATCH({
		params: { id: conversation.id },
		locals: { user },
		request: new Request('http://localhost/api/conversations/conversation-1', {
			method: 'PATCH',
			body: JSON.stringify({ systemPrompt })
		})
	} as any);
}

describe('conversation system prompt updates', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.getConversation.mockResolvedValue(conversation);
	});

	it('trims whitespace before storing the system prompt', async () => {
		conversationMocks.setConversationSystemPrompt.mockResolvedValue({
			...conversation,
			systemPrompt: 'Use careful sourcing.'
		});

		const response = await patch('  Use careful sourcing.  ');
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(conversationMocks.setConversationSystemPrompt).toHaveBeenCalledWith(
			user.id,
			conversation.id,
			'Use careful sourcing.'
		);
		expect(body.systemPrompt).toBe('Use careful sourcing.');
	});

	it('normalizes whitespace-only prompts to null before length validation', async () => {
		conversationMocks.setConversationSystemPrompt.mockResolvedValue({
			...conversation,
			systemPrompt: null
		});

		const response = await patch(' '.repeat(9000));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(conversationMocks.setConversationSystemPrompt).toHaveBeenCalledWith(
			user.id,
			conversation.id,
			null
		);
		expect(body.systemPrompt).toBeNull();
	});

	it('rejects prompts that are too long after trimming', async () => {
		await expect(patch(` ${'x'.repeat(8001)} `)).rejects.toMatchObject({ status: 400 });
		expect(conversationMocks.setConversationSystemPrompt).not.toHaveBeenCalled();
	});
});
