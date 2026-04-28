import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	createAccountInvite,
	findAccountByEmail,
	normalizeEmail,
	validEmail
} from '$lib/server/db/accounts';

interface Body {
	email?: string;
	name?: string;
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	const email = normalizeEmail(String(body.email ?? ''));
	const name = String(body.name ?? '').trim();
	if (!validEmail(email)) throw error(400, 'enter a valid email address');
	if (findAccountByEmail(email)) throw error(409, 'an account with that email already exists');

	try {
		const invite = createAccountInvite({ email, name });
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
