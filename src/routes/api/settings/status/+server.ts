import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getMaintenanceStatus } from '$lib/server/db/maintenance';
import { gatewayHealth } from '$lib/server/agent/transport';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	try {
		const [status, gateway] = await Promise.all([getMaintenanceStatus(), gatewayHealth()]);
		return json(
			{
				...status,
				ok: status.ok && gateway.ok,
				gateway
			},
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		return json(
			{ ok: false, error: 'unable to collect status' },
			{ status: 500, headers: { 'Cache-Control': 'no-store' } }
		);
	}
};
