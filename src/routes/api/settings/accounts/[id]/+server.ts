import { error, json, type RequestHandler } from '@sveltejs/kit';
import { accountCount, deleteAccount, getAccount } from '$lib/server/db/accounts';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const accountId = params.id;
	if (!accountId) throw error(400, 'account id is required');
	if (accountId === locals.user.id) throw error(400, 'you cannot remove your current account');
	if (accountCount() <= 1) throw error(400, 'at least one account is required');

	const account = getAccount(accountId);
	if (!account) throw error(404, 'account not found');

	deleteAccount(account.id);
	return json({ ok: true });
};
