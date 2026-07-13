import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listAccounts, ensureDefaultOrganizationForAccount, getNewsroomProfile } = vi.hoisted(() => ({
	listAccounts: vi.fn(),
	ensureDefaultOrganizationForAccount: vi.fn(),
	getNewsroomProfile: vi.fn()
}));

vi.mock('$lib/server/db/accounts', () => ({ listAccounts }));
vi.mock('$lib/server/db', () => ({ ensureDefaultOrganizationForAccount }));
vi.mock('$lib/server/documents/profiles', () => ({ getNewsroomProfile }));

import { load } from './+page.server';

const profile = {
	timezone: 'America/Toronto',
	homeMarket: 'Toronto',
	preferredDomains: ['cbc.ca']
};

const accounts = [
	{
		id: 'admin-1',
		email: 'admin@example.test',
		name: 'Admin',
		role: 'admin',
		createdAt: 1,
		updatedAt: 2,
		lastLoginAt: 3,
		status: 'active'
	},
	{
		id: 'member-1',
		email: 'member@example.test',
		name: 'Member',
		role: 'member',
		createdAt: 4,
		updatedAt: 5,
		lastLoginAt: 6,
		status: 'active'
	}
] as const;

function locals(role: 'admin' | 'member') {
	return {
		user: {
			id: `${role}-1`,
			email: `${role}@example.test`,
			name: role === 'admin' ? 'Admin' : 'Member',
			role
		}
	};
}

describe('settings page load privacy', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listAccounts.mockResolvedValue(accounts);
		ensureDefaultOrganizationForAccount.mockResolvedValue('org-1');
		getNewsroomProfile.mockResolvedValue(profile);
	});

	it('returns the complete account directory to admins', async () => {
		const result = (await load({ locals: locals('admin') } as never)) as any;

		expect(listAccounts).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ canManageAccounts: true, newsroomProfile: profile });
		expect(result.accounts).toHaveLength(2);
		expect(result.accounts[0]).toMatchObject({ id: 'admin-1', isCurrent: true });
	});

	it('does not query or return directory data for members', async () => {
		const result = (await load({ locals: locals('member') } as never)) as any;

		expect(listAccounts).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			canManageAccounts: false,
			accounts: [],
			newsroomProfile: profile
		});
		expect(JSON.stringify(result)).not.toContain('admin@example.test');
		expect(JSON.stringify(result)).not.toContain('lastLoginAt');
	});
});
