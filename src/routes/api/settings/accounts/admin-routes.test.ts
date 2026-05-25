import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountMocks = vi.hoisted(() => ({
	accountCount: vi.fn(),
	createPasswordOnlyInvite: vi.fn(),
	createPasswordSetupToken: vi.fn(),
	deleteAccount: vi.fn(),
	getAccount: vi.fn()
}));

vi.mock('$lib/server/db/accounts', () => accountMocks);

import * as accountsRoute from './+server';
import * as accountRoute from './[id]/+server';
import * as setupLinkRoute from './[id]/setup-link/+server';

const admin = { id: 'admin-1', email: 'admin@example.test', name: 'Admin', role: 'admin' as const };
const member = { id: 'member-1', email: 'member@example.test', name: 'Member', role: 'member' as const };
const target = {
	id: 'member-2',
	email: 'member2@example.test',
	name: 'Member 2',
	role: 'member' as const,
	passwordHash: null,
	setupTokenHash: null,
	setupTokenExpiresAt: null,
	createdAt: 1,
	updatedAt: 1,
	lastLoginAt: null
};

describe('account management admin routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('blocks members from creating account invites', async () => {
		await expect(
			accountsRoute.POST({ locals: { user: member }, url: new URL('http://localhost') } as any)
		).rejects.toMatchObject({ status: 403 });
		expect(accountMocks.createPasswordOnlyInvite).not.toHaveBeenCalled();
	});

	it('allows admins to create account invites', async () => {
		accountMocks.createPasswordOnlyInvite.mockResolvedValue({
			account: target,
			token: 'setup-token',
			expiresAt: 1000
		});

		const response = await accountsRoute.POST({
			locals: { user: admin },
			url: new URL('http://localhost')
		} as any);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.account.id).toBe(target.id);
		expect(body.account.role).toBe('member');
		expect(body.setupUrl).toBe('http://localhost/account-setup/setup-token');
	});

	it('blocks members from deleting other accounts', async () => {
		await expect(
			accountRoute.DELETE({ params: { id: target.id }, locals: { user: member } } as any)
		).rejects.toMatchObject({ status: 403 });
		expect(accountMocks.deleteAccount).not.toHaveBeenCalled();
	});

	it('allows admins to delete other accounts', async () => {
		accountMocks.accountCount.mockResolvedValue(2);
		accountMocks.getAccount.mockResolvedValue(target);

		const response = await accountRoute.DELETE({
			params: { id: target.id },
			locals: { user: admin }
		} as any);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(accountMocks.deleteAccount).toHaveBeenCalledWith(target.id);
	});

	it('blocks members from minting setup links for other accounts', async () => {
		await expect(
			setupLinkRoute.POST({
				params: { id: target.id },
				locals: { user: member },
				url: new URL('http://localhost')
			} as any)
		).rejects.toMatchObject({ status: 403 });
		expect(accountMocks.createPasswordSetupToken).not.toHaveBeenCalled();
	});

	it('allows admins to mint setup links', async () => {
		accountMocks.getAccount.mockResolvedValue(target);
		accountMocks.createPasswordSetupToken.mockResolvedValue({
			token: 'setup-token',
			expiresAt: 1000
		});

		const response = await setupLinkRoute.POST({
			params: { id: target.id },
			locals: { user: admin },
			url: new URL('http://localhost')
		} as any);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.setupUrl).toBe('http://localhost/account-setup/setup-token');
		expect(body.expiresAt).toBe(1000);
	});
});
