import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getOperatorFooterStatus } from '$lib/server/operator-status';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	try {
		return json(await getOperatorFooterStatus(locals.user.id), {
			headers: { 'Cache-Control': 'no-store' }
		});
	} catch {
		return json(
			{ ok: false, error: 'unable to collect operator status' },
			{ status: 500, headers: { 'Cache-Control': 'no-store' } }
		);
	}
};
