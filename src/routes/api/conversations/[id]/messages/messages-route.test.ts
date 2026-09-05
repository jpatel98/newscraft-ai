import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversationMocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	getLatestMessagesPage: vi.fn(),
	getMessageById: vi.fn(),
	getMessageCount: vi.fn(),
	getMessageWindow: vi.fn(),
	getMessagesBefore: vi.fn(),
	getMessagesBetween: vi.fn(),
	getMessagesByIds: vi.fn(),
	parseContent: vi.fn((value: string) => value)
}));
const runMocks = vi.hoisted(() => ({ listHermesRunStatesForMessages: vi.fn() }));

vi.mock('$lib/server/db/conversations', () => conversationMocks);
vi.mock('$lib/server/db/hermes-runs', () => runMocks);

import { GET } from './+server';

const owner = { id: 'account-1' };
const conversation = { id: 'conversation-1', title: 'Thread' };

function row(id: string, createdAt = Number(id.replace('m-', '')), content = id) {
	return {
		id,
		conversationId: conversation.id,
		role: 'user',
		content,
		toolCalls: null,
		partial: 0,
		resumeClaimedAt: null,
		createdAt
	};
}

function cursor(createdAt: number, id: string): string {
	return btoa(JSON.stringify({ createdAt, id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function event(url: string) {
	return { params: { id: conversation.id }, url: new URL(url, 'https://example.test'), locals: { user: owner } } as any;
}

describe('conversation history route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.getConversation.mockResolvedValue(conversation);
		conversationMocks.getMessageCount.mockResolvedValue(3);
		runMocks.listHermesRunStatesForMessages.mockResolvedValue([]);
	});

	it('checks ownership before malformed query details', async () => {
		conversationMocks.getConversation.mockResolvedValue(undefined);
		await expect(GET({ ...event('/api/conversations/conversation-1/messages?limit=bad') })).rejects.toMatchObject({ status: 404 });
		expect(conversationMocks.getLatestMessagesPage).not.toHaveBeenCalled();
	});

	it('rejects invalid bounds and conflicting modes', async () => {
		await expect(GET(event('/api/conversations/conversation-1/messages?limit=0'))).rejects.toMatchObject({ status: 400 });
		await expect(GET(event('/api/conversations/conversation-1/messages?limit=51'))).rejects.toMatchObject({ status: 400 });
		await expect(GET(event('/api/conversations/conversation-1/messages?after=x'))).rejects.toMatchObject({ status: 400 });
		await expect(
			GET(event(`/api/conversations/conversation-1/messages?around=m-2&before=${cursor(1, 'm-1')}`))
		).rejects.toMatchObject({ status: 400 });
	});

	it('returns a bounded newest page and exact durable states', async () => {
		conversationMocks.getLatestMessagesPage.mockResolvedValue([row('m-1'), row('m-2'), row('m-3')]);
		runMocks.listHermesRunStatesForMessages.mockResolvedValue([
			{ assistantMessageId: 'm-3', state: 'complete', errorMessage: null }
		]);
		const response = await GET(event('/api/conversations/conversation-1/messages?limit=2'));
		const body = await response.json();
		expect(body.messages.map((message: { id: string }) => message.id)).toEqual(['m-2', 'm-3']);
		expect(body.hasOlder).toBe(true);
		expect(runMocks.listHermesRunStatesForMessages).toHaveBeenCalledWith('account-1', 'conversation-1', ['m-1', 'm-2', 'm-3']);
	});

	it('uses exclusive equal-timestamp older boundaries and preserves the nearer rows', async () => {
		conversationMocks.getMessageById.mockResolvedValue(row('m-2', 100));
		conversationMocks.getMessagesBefore.mockResolvedValue([row('m-1', 100), row('m-3', 100), row('m-4', 101)]);
		const response = await GET(event(`/api/conversations/conversation-1/messages?before=${cursor(100, 'm-2')}&limit=2`));
		const body = await response.json();
		expect(body.messages.map((message: { id: string }) => message.id)).toEqual(['m-3', 'm-4']);
		expect(body.gapBefore).toBe(true);
	});

	it('validates both owned range boundaries and keeps the range exclusive', async () => {
		conversationMocks.getMessageById.mockImplementation(async (id: string) => row(id, id === 'm-1' ? 1 : 5));
		conversationMocks.getMessagesBetween.mockResolvedValue([row('m-2'), row('m-3')]);
		const response = await GET(
			event(`/api/conversations/conversation-1/messages?after=${cursor(1, 'm-1')}&before=${cursor(5, 'm-5')}&limit=2`)
		);
		const body = await response.json();
		expect(body.mode).toBe('range');
		expect(body.messages.map((message: { id: string }) => message.id)).toEqual(['m-2', 'm-3']);
		expect(conversationMocks.getMessagesBetween).toHaveBeenCalledWith('conversation-1', { createdAt: 1, id: 'm-1' }, { createdAt: 5, id: 'm-5' }, 2);
	});

	it('returns a bounded target window and never drops an oversized target', async () => {
		const target = row('m-2', 2, 'x'.repeat(1_100_000));
		conversationMocks.getMessageById.mockResolvedValue(target);
		conversationMocks.getMessageWindow.mockResolvedValue({ before: [row('m-1')], after: [row('m-3')] });
		const response = await GET(event('/api/conversations/conversation-1/messages?around=m-2'));
		const body = await response.json();
		expect(body.targetId).toBe('m-2');
		expect(body.messages.map((message: { id: string }) => message.id)).toEqual(['m-2']);
		expect(body.messages[0].content).toHaveLength(1_100_000);
	});

	it('returns only owned exact ids', async () => {
		conversationMocks.getMessagesByIds.mockResolvedValue([row('m-2')]);
		const response = await GET(event('/api/conversations/conversation-1/messages?ids=m-1%2Cm-2'));
		const body = await response.json();
		expect(body.mode).toBe('ids');
		expect(body.requestedIds).toEqual(['m-1', 'm-2']);
		expect(body.messages.map((message: { id: string }) => message.id)).toEqual(['m-2']);
	});
});

