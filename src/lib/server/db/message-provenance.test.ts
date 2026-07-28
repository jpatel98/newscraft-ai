import { beforeEach, describe, expect, it, vi } from 'vitest';

const limitMock = vi.fn(async () => []);
const orderByMock = vi.fn(() => ({ limit: limitMock }));
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

vi.mock('drizzle-orm', () => ({
	and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
	desc: vi.fn((column: unknown) => ({ type: 'desc', column })),
	eq: vi.fn((column: unknown, value: unknown) => ({ type: 'eq', column, value })),
	inArray: vi.fn((column: unknown, values: unknown[]) => ({ type: 'inArray', column, values }))
}));

vi.mock('./index', () => ({
	db: {
		select: selectMock
	}
}));

vi.mock('./schema', () => ({
	messageProvenance: {
		messageId: { name: 'message_id' },
		conversationId: { name: 'conversation_id' },
		updatedAt: { name: 'updated_at' }
	}
}));

describe('message provenance queries', () => {
	beforeEach(() => {
		limitMock.mockClear();
		orderByMock.mockClear();
		whereMock.mockClear();
		fromMock.mockClear();
		selectMock.mockClear();
	});

	it('skips the database when no candidate message ids are provided', async () => {
		const { getConversationMessageProvenance } = await import('./message-provenance');

		const rows = await getConversationMessageProvenance('conversation-1', { messageIds: [] });

		expect(rows).toEqual([]);
		expect(selectMock).not.toHaveBeenCalled();
	});

	it('applies message-id filtering and caps the query limit', async () => {
		const { getConversationMessageProvenance } = await import('./message-provenance');

		await getConversationMessageProvenance('conversation-1', {
			messageIds: ['a1', 'a2', 'a2'],
			limit: 100
		});

		expect(selectMock).toHaveBeenCalledTimes(1);
		expect(whereMock).toHaveBeenCalledTimes(1);
		expect(orderByMock).toHaveBeenCalledTimes(1);
		expect(limitMock).toHaveBeenCalledWith(24);
	});
});
