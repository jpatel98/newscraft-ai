import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createPasswordSetupToken, getAccount } from '$lib/server/db/accounts';

export const POST: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const accountId = params.id;
	if (!accountId) throw error(400, 'account id is required');

	const account = await getAccount(accountId);
	if (!account) throw error(404, 'account not found');

	const token = await createPasswordSetupToken(account.id);
	if (!token) throw error(404, 'account not found');

	return json({
		setupUrl: new URL(`/account-setup/${token.token}`, url.origin).toString(),
		expiresAt: token.expiresAt
	});
};
