/**
 * E2E test-account provisioning endpoint.
 *
 * Only active when `E2E_SECRET` is set in the environment (i.e. during
 * Playwright runs). Returns the test-account password so the suite can
 * sign in without knowing whether this is a fresh or pre-seeded database.
 *
 * Never touches production auth logic — it only calls the same
 * `createPasswordOnlyAccount` helper that the `/setup` page uses.
 */
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { accountCount, createPasswordOnlyAccount, findAccountByPassword } from '$lib/server/db/accounts';

export const POST: RequestHandler = async ({ request }) => {
	const secret = env.E2E_SECRET ?? '';
	if (!secret) throw error(404, 'not found');

	let body: { secret?: string; password?: string };
	try {
		body = (await request.json()) as { secret?: string; password?: string };
	} catch {
		throw error(400, 'invalid json');
	}

	if (!body.secret || body.secret !== secret) throw error(403, 'forbidden');

	const password = body.password;
	if (!password || password.length < 8) throw error(400, 'password too short');

	// If an account with this password already exists, return success immediately.
	const existing = await findAccountByPassword(password);
	if (existing) return json({ ok: true, created: false });

	// If the DB has no accounts at all, create it as the first (admin) account.
	// Otherwise create it as a regular member account.
	try {
		await createPasswordOnlyAccount(password);
		return json({ ok: true, created: true });
	} catch {
		throw error(409, 'could not create test account');
	}
};
