import { error, json, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/authorization';
import { accountCount, deleteAccount, getAccount } from '$lib/server/db/accounts';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals.user);
	const accountId = params.id;
	if (!accountId) throw error(400, 'account id is required');
	if (accountId === locals.user.id) throw error(400, 'you cannot remove your current account');
	if ((await accountCount()) <= 1) throw error(400, 'at least one account is required');

	const account = await getAccount(accountId);
	if (!account) throw error(404, 'account not found');

	await deleteAccount(account.id);
	return json({ ok: true });
};
