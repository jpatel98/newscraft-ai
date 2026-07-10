import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountMocks = vi.hoisted(() => ({
	accountCount: vi.fn()
}));

vi.mock('$lib/server/db/accounts', () => accountMocks);

import { actions, load } from './+page.server';

describe('signup access routing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sends unauthenticated users to first-account setup when no accounts exist', async () => {
		accountMocks.accountCount.mockResolvedValue(0);

		await expect(load({ locals: { user: null } } as any)).rejects.toMatchObject({
			status: 303,
			location: '/setup'
		});
		await expect(actions.default({} as any)).rejects.toMatchObject({
			status: 303,
			location: '/setup'
		});
	});

	it('sends unauthenticated users to login once accounts exist', async () => {
		accountMocks.accountCount.mockResolvedValue(1);

		await expect(load({ locals: { user: null } } as any)).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		await expect(actions.default({} as any)).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
	});

	it('keeps authenticated users out of signup', async () => {
		await expect(load({ locals: { user: { id: 'acct_1' } } } as any)).rejects.toMatchObject({
			status: 303,
			location: '/'
		});
		expect(accountMocks.accountCount).not.toHaveBeenCalled();
	});
});
