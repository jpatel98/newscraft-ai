import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	listStoryClaims: vi.fn(),
	workerLedgerCopy: vi.fn(),
	checkRateLimit: vi.fn()
}));
vi.mock('$lib/server/db/conversations', () => ({ getConversation: mocks.getConversation }));
vi.mock('$lib/server/db/story-claims', () => ({ listStoryClaims: mocks.listStoryClaims }));
vi.mock('$lib/server/ledger-copy', () => ({ workerLedgerCopy: mocks.workerLedgerCopy }));
vi.mock('$lib/server/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }));

import { POST } from './+server';

const event = (user: { id: string } | null = { id: 'owner' }) => ({
	locals: { user }, params: { id: 'conversation' },
	request: new Request('https://test.invalid/copy', { method: 'POST', body: JSON.stringify({ format: 'intro' }) })
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getConversation.mockResolvedValue({ id: 'conversation', title: 'Story' });
	mocks.checkRateLimit.mockReturnValue({ allowed: false });
});

describe('ledger copy authorization and cost boundary', () => {
	it('rejects anonymous requests', async () => {
		await expect(POST(event(null) as never)).rejects.toMatchObject({ status: 401 });
		expect(mocks.getConversation).not.toHaveBeenCalled();
	});

	it('rejects non-owned conversations before reading their claims', async () => {
		mocks.getConversation.mockResolvedValue(null);
		await expect(POST(event() as never)).rejects.toMatchObject({ status: 404 });
		expect(mocks.getConversation).toHaveBeenCalledWith('owner', 'conversation');
		expect(mocks.listStoryClaims).not.toHaveBeenCalled();
		expect(mocks.workerLedgerCopy).not.toHaveBeenCalled();
	});

	it('limits repeated paid copy requests per authenticated account', async () => {
		await expect(POST(event() as never)).rejects.toMatchObject({ status: 429 });
		expect(mocks.checkRateLimit).toHaveBeenCalledWith('ledger-copy:owner', { limit: 30, windowMs: 3_600_000 });
		expect(mocks.listStoryClaims).not.toHaveBeenCalled();
		expect(mocks.workerLedgerCopy).not.toHaveBeenCalled();
	});
});
