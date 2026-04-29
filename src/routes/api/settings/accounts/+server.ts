import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createPasswordOnlyInvite } from '$lib/server/db/accounts';

export const POST: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	try {
		const invite = createPasswordOnlyInvite();
		const setupUrl = new URL(`/account-setup/${invite.token}`, url.origin).toString();
		return json({
			account: {
				id: invite.account.id,
				email: invite.account.email,
				name: invite.account.name,
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
