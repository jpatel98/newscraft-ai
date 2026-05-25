import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/authorization';
import { createPasswordOnlyInvite } from '$lib/server/db/accounts';

export const POST: RequestHandler = async ({ locals, url }) => {
	requireAdmin(locals.user);

	try {
		const invite = await createPasswordOnlyInvite();
		const setupUrl = new URL(`/account-setup/${invite.token}`, url.origin).toString();
		return json({
			account: {
				id: invite.account.id,
				email: invite.account.email,
				name: invite.account.name,
				role: invite.account.role,
				createdAt: invite.account.createdAt,
				updatedAt: invite.account.updatedAt,
				lastLoginAt: invite.account.lastLoginAt,
				status: 'pending'
			},
			setupUrl,
			expiresAt: invite.expiresAt
		});
	} catch {
		throw error(409, 'account could not be created');
	}
};
