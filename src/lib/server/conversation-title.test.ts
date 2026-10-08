import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	completion: vi.fn(),
	getConversation: vi.fn(),
	getMessagesBatch: vi.fn(),
	setConversationTitleIfCurrent: vi.fn()
}));
vi.mock('$lib/server/agent/transport', () => ({ completion: mocks.completion }));
vi.mock('$lib/server/db/conversations', () => ({
	getConversation: mocks.getConversation,
	getMessagesBatch: mocks.getMessagesBatch,
	parseContent: (content: string) => content.startsWith('[') ? JSON.parse(content) : content,
	setConversationTitleIfCurrent: mocks.setConversationTitleIfCurrent
}));
import { fallbackConversationTitle, generateConversationTitle, sanitizeConversationTitle } from './conversation-title';

const conversation = {
	id: 'conversation-1', accountId: 'account-1', orgId: null, title: '', systemPrompt: null,
	createdAt: 1, updatedAt: 1, pinned: 0
};
const row = (id: string, role: string, content: string) => ({ id, role, content, createdAt: 100, partial: 0 });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getConversation.mockResolvedValue(conversation);
	mocks.getMessagesBatch.mockResolvedValue([row('user-1', 'user', 'Please research Ontario transit funding.')]);
	mocks.setConversationTitleIfCurrent.mockImplementation(async (_account, _id, _oldTitle, title) => ({ ...conversation, title }));
});

describe('local conversation titles', () => {
	it('keeps useful task subjects, removes request filler and bounds the title', () => {
		expect(fallbackConversationTitle('What is the latest verified development in Canada-US trade today? Use sources.'))
			.toBe('Latest verified development in Canada-US trade today');
		expect(fallbackConversationTitle('Um, I would like us to work on auto titling NewsCraft threads.'))
			.toBe('Auto titling NewsCraft threads');
		expect(fallbackConversationTitle('Production polish audit 20260819-A. What is the capital of Ontario?'))
			.toBe('Capital of Ontario');
		expect(fallbackConversationTitle('   ')).toBe('New conversation');
		expect(fallbackConversationTitle('Please compare [Ontario transit](https://example.test/story) [1]. Include sources.'))
			.toBe('Compare Ontario transit');
		expect(fallbackConversationTitle('A'.repeat(120))).toHaveLength(80);
	});

	it('keeps title sanitation compatible with saved display titles', () => {
		expect(sanitizeConversationTitle('Title: **Ontario budget OCVO.**\nExtra explanation')).toBe('Ontario budget OCVO');
	});

	it('generates a meaningful title from the first user task without a model request', async () => {
		mocks.getMessagesBatch.mockResolvedValue([
			row('system-1', 'system', 'Internal instructions'),
			row('assistant-1', 'assistant', 'Unrelated assistant suggestion'),
			row('user-1', 'user', 'Could you please compare Ontario transit funding?'),
			row('user-2', 'user', 'Then make a CSV.')
		]);
		await expect(generateConversationTitle('account-1', conversation.id))
			.resolves.toMatchObject({ title: 'Compare Ontario transit funding', generated: true });
		expect(mocks.setConversationTitleIfCurrent).toHaveBeenCalledWith(
			'account-1', conversation.id, '', 'Compare Ontario transit funding');
		expect(mocks.completion).not.toHaveBeenCalled();
	});

	it('preserves a manual title without reading history', async () => {
		mocks.getConversation.mockResolvedValue({ ...conversation, title: 'Election night plan' });
		await expect(generateConversationTitle('account-1', conversation.id))
			.resolves.toMatchObject({ title: 'Election night plan', generated: false });
		expect(mocks.getMessagesBatch).not.toHaveBeenCalled();
		expect(mocks.setConversationTitleIfCurrent).not.toHaveBeenCalled();
	});

	it('replaces an automatic placeholder using the local task', async () => {
		mocks.getConversation.mockResolvedValue({ ...conversation, title: '(untitled)' });
		await expect(generateConversationTitle('account-1', conversation.id))
			.resolves.toMatchObject({ title: 'Research Ontario transit funding', generated: true });
		expect(mocks.setConversationTitleIfCurrent).toHaveBeenCalledWith(
			'account-1', conversation.id, '(untitled)', 'Research Ontario transit funding');
	});

	it('honors a title edited between lookup and the conditional write', async () => {
		mocks.getConversation.mockResolvedValueOnce(conversation)
			.mockResolvedValueOnce({ ...conversation, title: 'Editor title' });
		mocks.setConversationTitleIfCurrent.mockResolvedValue(undefined);
		await expect(generateConversationTitle('account-1', conversation.id))
			.resolves.toMatchObject({ title: 'Editor title', generated: false });
		expect(mocks.setConversationTitleIfCurrent).toHaveBeenCalledTimes(1);
	});

	it('uses stable small history pages and extracts text from image attachments', async () => {
		mocks.getMessagesBatch.mockResolvedValueOnce(Array.from({ length: 16 }, (_, index) => row(`m-${index}`, 'system', 'Metadata')))
			.mockResolvedValueOnce([row('user-1', 'user', JSON.stringify([
				{ type: 'image_url', image_url: { url: 'https://example.test/map.png' } },
				{ type: 'text', text: 'Explain the Ontario transit map.' }
			]))]);
		await expect(generateConversationTitle('account-1', conversation.id))
			.resolves.toMatchObject({ title: 'Explain the Ontario transit map', generated: true });
		expect(mocks.getMessagesBatch.mock.calls).toEqual([
			[conversation.id, null, 16], [conversation.id, { createdAt: 100, id: 'm-15' }, 16]
		]);
	});

	it('bounds unusable history and leaves an empty conversation untitled', async () => {
		mocks.getMessagesBatch.mockResolvedValue(Array.from({ length: 16 }, (_, index) => row(`m-${index}`, 'assistant', 'No user task')));
		await expect(generateConversationTitle('account-1', conversation.id))
			.resolves.toMatchObject({ title: '', generated: false });
		expect(mocks.getMessagesBatch).toHaveBeenCalledTimes(8);
		expect(mocks.setConversationTitleIfCurrent).not.toHaveBeenCalled();
	});

	it('returns no title for another account or a missing conversation', async () => {
		mocks.getConversation.mockResolvedValue(undefined);
		await expect(generateConversationTitle('foreign-account', conversation.id)).resolves.toBeNull();
		expect(mocks.getMessagesBatch).not.toHaveBeenCalled();
	});
});
