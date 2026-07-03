import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversationMocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	getMessages: vi.fn()
}));

const feedbackMocks = vi.hoisted(() => ({
	attachLinearIssueToFeedback: vi.fn(),
	saveChatFeedback: vi.fn()
}));

const diagnosticMocks = vi.hoisted(() => ({
	recentChatDiagnosticsWithPersisted: vi.fn(),
	recordChatDiagnostic: vi.fn()
}));

const linearMocks = vi.hoisted(() => ({
	createLinearFeedbackIssue: vi.fn()
}));

vi.mock('$lib/server/db/conversations', () => conversationMocks);
vi.mock('$lib/server/db/feedback', () => feedbackMocks);
vi.mock('$lib/server/chat-diagnostics', () => diagnosticMocks);
vi.mock('$lib/server/linear-feedback', () => linearMocks);

import { POST } from './+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };
const conversation = {
	id: 'conversation-1',
	accountId: user.id,
	title: 'Story',
	systemPrompt: null,
	createdAt: 1,
	updatedAt: 2,
	pinned: 0
};

function postFeedback(comment = 'The answer missed the newest source.') {
	return POST({
		params: { id: conversation.id },
		locals: { user },
		request: new Request('http://localhost/api/conversations/conversation-1/feedback', {
			method: 'POST',
			headers: { 'user-agent': 'vitest' },
			body: JSON.stringify({ comment })
		})
	} as any);
}

describe('conversation feedback route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.getConversation.mockResolvedValue(conversation);
		conversationMocks.getMessages.mockResolvedValue([
			{
				id: 'message-1',
				role: 'assistant',
				content: 'Draft answer',
				toolCalls: null,
				partial: 0,
				createdAt: 3
			}
		]);
		diagnosticMocks.recentChatDiagnosticsWithPersisted.mockResolvedValue([
			{
				id: 'diag-persisted',
				conversationId: conversation.id,
				type: 'chat.stream.error',
				createdAt: 4,
				details: { status: 500 }
			}
		]);
		feedbackMocks.saveChatFeedback.mockResolvedValue({
			id: 'feedback-1',
			accountId: user.id,
			conversationId: conversation.id,
			comment: 'The answer missed the newest source.',
			snapshotJson: '{}',
			linearIssueId: null,
			linearIssueIdentifier: null,
			linearIssueUrl: null,
			userAgent: 'vitest',
			createdAt: 5
		});
		linearMocks.createLinearFeedbackIssue.mockResolvedValue(null);
	});

	it('captures persisted diagnostics in the saved feedback snapshot', async () => {
		const response = await postFeedback();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(diagnosticMocks.recordChatDiagnostic).toHaveBeenCalledWith(conversation.id, 'feedback.capture.request', {
			messageCount: 1,
			commentChars: 36
		});
		expect(diagnosticMocks.recentChatDiagnosticsWithPersisted).toHaveBeenCalledWith(conversation.id);
		expect(feedbackMocks.saveChatFeedback).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: user.id,
				conversationId: conversation.id,
				userAgent: 'vitest',
				snapshot: expect.objectContaining({
					diagnostics: [
						expect.objectContaining({
							id: 'diag-persisted',
							type: 'chat.stream.error',
							details: { status: 500 }
						})
					],
					messageCount: 1
				})
			})
		);
		expect(body).toMatchObject({
			id: 'feedback-1',
			conversationId: conversation.id,
			messageCount: 1
		});
	});
});
