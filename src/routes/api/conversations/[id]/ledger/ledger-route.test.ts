import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getConversation: vi.fn(), listStoryClaims: vi.fn(), lastStoryClaimEventSeq: vi.fn(), listStoryClaimEvents: vi.fn() }));
vi.mock('$lib/server/db/conversations', () => ({ getConversation: mocks.getConversation }));
vi.mock('$lib/server/db/story-claims', () => mocks);
import { GET } from './+server';

const event = (since?: number) => ({
	locals: { user: { id: 'owner' } }, params: { id: 'conversation' },
	url: new URL(`https://test.invalid/ledger${since === undefined ? '' : `?since=${since}`}`)
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getConversation.mockResolvedValue({ id: 'conversation' });
	mocks.listStoryClaims.mockResolvedValue([]);
	mocks.lastStoryClaimEventSeq.mockResolvedValue(900);
	mocks.listStoryClaimEvents.mockResolvedValue([]);
});

describe('ledger change cursor', () => {
	it('does not acknowledge events beyond the bounded returned page', async () => {
		mocks.listStoryClaimEvents.mockResolvedValue(Array.from({ length: 300 }, (_, index) => ({
			seq: index + 11, claimId: 'claim', kind: 'check_opened', actor: 'person', actorName: 'Editor', data: {}, createdAt: 1
		})));
		const response = await GET(event(10) as never);
		const body = await response.json();
		expect(body.changes).toHaveLength(300);
		expect(body.last_seq).toBe(310);
		expect(mocks.listStoryClaimEvents).toHaveBeenCalledWith('conversation', 10, 300);
	});

	it('does not skip concurrent events when the event read returns no changes', async () => {
		const response = await GET(event(10) as never);
		expect(await response.json()).toMatchObject({ last_seq: 10, changes: [] });
	});

	it('uses the newest sequence only for the initial baseline', async () => {
		const response = await GET(event() as never);
		expect(await response.json()).toEqual({ claims: [], last_seq: 900 });
		expect(mocks.listStoryClaimEvents).not.toHaveBeenCalled();
	});

	it.each(['baseline', 'incremental'])('reads the %s cursor before the claim snapshot', async (mode) => {
		const started = Promise.withResolvers<void>();
		const pendingRead = Promise.withResolvers<void>();
		const nextChange = {
			seq: 901, claimId: 'claim', kind: 'check_opened', actor: 'person', actorName: 'Editor', data: {}, createdAt: 1
		};
		const cursorRead = mode === 'baseline' ? mocks.lastStoryClaimEventSeq : mocks.listStoryClaimEvents;
		cursorRead.mockImplementationOnce(async () => {
			started.resolve();
			await pendingRead.promise;
			return mode === 'baseline' ? 900 : [];
		});
		const pending = GET(event(mode === 'baseline' ? undefined : 900) as never);
		await started.promise;
		expect(mocks.listStoryClaims).not.toHaveBeenCalled();
		mocks.listStoryClaims.mockResolvedValue([{ id: 'claim', claim: 'Concurrent update', status: 'confirmed', updatedAt: 1 }]);
		mocks.listStoryClaimEvents.mockResolvedValue([nextChange]);
		pendingRead.resolve();
		const body = await (await pending).json();
		expect(body.last_seq).toBe(900);
		expect(body.claims).toEqual([expect.objectContaining({ id: 'claim', claim: 'Concurrent update' })]);
		const next = await GET(event(body.last_seq) as never);
		expect(await next.json()).toMatchObject({ last_seq: 901, changes: [expect.objectContaining({ seq: 901 })] });
		expect(mocks.listStoryClaimEvents).toHaveBeenLastCalledWith('conversation', 900, 300);
	});

	it('checks ownership before accessing the ledger', async () => {
		mocks.getConversation.mockResolvedValue(null);
		await expect(GET(event(10) as never)).rejects.toMatchObject({ status: 404 });
		expect(mocks.getConversation).toHaveBeenCalledWith('owner', 'conversation');
		expect(mocks.listStoryClaims).not.toHaveBeenCalled();
		expect(mocks.lastStoryClaimEventSeq).not.toHaveBeenCalled();
		expect(mocks.listStoryClaimEvents).not.toHaveBeenCalled();
	});
});
