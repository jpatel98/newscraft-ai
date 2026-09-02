import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	completion: vi.fn(),
	getConversation: vi.fn(),
	getMessages: vi.fn(),
	setConversationTitleIfCurrent: vi.fn()
}));

vi.mock('$lib/server/agent/transport', () => ({ completion: mocks.completion }));
vi.mock('$lib/server/db/conversations', () => ({
	getConversation: mocks.getConversation,
	getMessages: mocks.getMessages,
	parseContent: (content: string) => content,
	setConversationTitleIfCurrent: mocks.setConversationTitleIfCurrent
}));

import {
	fallbackConversationTitle,
	generateConversationTitle,
	sanitizeConversationTitle
} from './conversation-title';

beforeEach(() => vi.clearAllMocks());

describe('conversation title fallback', () => {
	it('uses a useful bounded title from the first request', () => {
		expect(
			fallbackConversationTitle('What is the latest verified development in Canada-US trade today? Use sources.')
		).toBe('What is the latest verified development in Canada-US');
	});

	it('removes the production audit marker and supplies an empty fallback', () => {
		expect(
			fallbackConversationTitle('Production polish audit 20260819-A. What is the capital of Ontario?')
		).toBe('What is the capital of Ontario');
		expect(fallbackConversationTitle('   ')).toBe('New conversation');
	});

	it('removes request filler from the fallback title', () => {
		expect(fallbackConversationTitle('Um, I would like us to work on auto titling NewsCraft threads.')).toBe(
			'Auto titling NewsCraft threads'
		);
	});

	it('accepts only one bounded title line from the model', () => {
		expect(sanitizeConversationTitle('Title: **Ontario budget OCVO.**\nExtra explanation')).toBe(
			'Ontario budget OCVO'
		);
	});

	it('does not replace a title that a person changes during generation', async () => {
		const base = {
			id: 'conversation-1',
			accountId: 'account-1',
			orgId: null,
			title: '',
			systemPrompt: null,
			createdAt: 1,
			updatedAt: 1,
			pinned: 0
		};
		mocks.getConversation
			.mockResolvedValueOnce(base)
			.mockResolvedValueOnce({ ...base, title: 'Manual title' });
		mocks.getMessages.mockResolvedValue([
			{ id: 'message-1', role: 'user', content: 'Latest Ontario news', partial: 0 },
			{ id: 'message-2', role: 'assistant', content: '', partial: 1 }
		]);
		mocks.completion.mockResolvedValue({ choices: [{ message: { content: 'Ontario news update' } }] });
		mocks.setConversationTitleIfCurrent
			.mockResolvedValueOnce({ ...base, title: 'Latest Ontario news' })
			.mockResolvedValueOnce(undefined);

		const result = await generateConversationTitle('account-1', 'conversation-1');

		expect(result).toMatchObject({ title: 'Manual title', generated: false });
		expect(mocks.setConversationTitleIfCurrent).toHaveBeenCalledWith(
			'account-1',
			'conversation-1',
			'Latest Ontario news',
			'Ontario news update'
		);
		expect(mocks.completion).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: expect.not.arrayContaining([
					expect.objectContaining({ role: 'assistant', content: '' })
				])
			}),
			expect.objectContaining({ sessionId: 'title-conversation-1' })
		);
	});

	it('does not replace a title that a person changes before the fallback write', async () => {
		const base = {
			id: 'conversation-2',
			accountId: 'account-1',
			orgId: null,
			title: '',
			systemPrompt: null,
			createdAt: 1,
			updatedAt: 1,
			pinned: 0
		};
		mocks.getConversation
			.mockResolvedValueOnce(base)
			.mockResolvedValueOnce({ ...base, title: 'Editor title' });
		mocks.getMessages.mockResolvedValue([
			{ id: 'message-2', role: 'user', content: 'Toronto council update', partial: 0 }
		]);
		mocks.setConversationTitleIfCurrent.mockResolvedValue(undefined);

		const result = await generateConversationTitle('account-1', 'conversation-2');

		expect(result).toMatchObject({ title: 'Editor title', generated: false });
		expect(mocks.completion).not.toHaveBeenCalled();
	});

	it('replaces an untitled placeholder with a useful fallback before the model reply', async () => {
		const base = {
			id: 'conversation-3',
			accountId: 'account-1',
			orgId: null,
			title: '(untitled)',
			systemPrompt: null,
			createdAt: 1,
			updatedAt: 1,
			pinned: 0
		};
		mocks.getConversation.mockResolvedValue(base);
		mocks.getMessages.mockResolvedValue([
			{ id: 'message-3', role: 'user', content: 'Plan election night coverage', partial: 0 }
		]);
		mocks.setConversationTitleIfCurrent
			.mockResolvedValueOnce({ ...base, title: 'Plan election night coverage' })
			.mockResolvedValueOnce({ ...base, title: 'Election night coverage plan' });
		mocks.completion.mockResolvedValue({
			choices: [{ message: { content: 'Election night coverage plan' } }]
		});

		const result = await generateConversationTitle('account-1', 'conversation-3', { force: true });

		expect(mocks.setConversationTitleIfCurrent).toHaveBeenNthCalledWith(
			1,
			'account-1',
			'conversation-3',
			'(untitled)',
			'Plan election night coverage'
		);
		expect(result).toMatchObject({ title: 'Election night coverage plan', generated: true });
	});
});
