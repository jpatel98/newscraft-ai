import { beforeEach, describe, expect, it, vi } from 'vitest';
const database = vi.hoisted(() => ({ getConversation: vi.fn(), deleteMessagesFrom: vi.fn() }));
vi.mock('$lib/server/db/conversations', () => database);
import { DELETE } from './+server';
function event(user: object | null, conversationId = 'conversation-one') {
    return { params: { id: 'message-one' }, locals: { user },
        request: new Request('https://app.example/api/messages/message-one/onwards', {
            method: 'DELETE', body: JSON.stringify({ conversation_id: conversationId })
        }) } as any;
}
describe('managed conversation history mutation boundary', () => {
    beforeEach(() => vi.clearAllMocks());
    it('edits the owned canonical history after verifying conversation ownership', async () => {
        database.getConversation.mockResolvedValue({ id: 'conversation-one' });
        database.deleteMessagesFrom.mockResolvedValue(2);
        const response = await DELETE(event({ id: 'account-one' }));
        expect(await response.json()).toEqual({ ok: true, removed: 2 });
        expect(database.getConversation).toHaveBeenCalledWith('account-one', 'conversation-one');
        expect(database.deleteMessagesFrom).toHaveBeenCalledWith('conversation-one', 'message-one');
    });
    it('does not expose another account conversation', async () => {
        database.getConversation.mockResolvedValue(undefined);
        await expect(DELETE(event({ id: 'account-two' }))).rejects.toMatchObject({ status: 404 });
        expect(database.deleteMessagesFrom).not.toHaveBeenCalled();
    });
    it('requires a verified account', async () => {
        await expect(DELETE(event(null))).rejects.toMatchObject({ status: 401 });
        expect(database.getConversation).not.toHaveBeenCalled();
    });
});
