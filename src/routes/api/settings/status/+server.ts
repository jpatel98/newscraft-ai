import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getMaintenanceStatus } from '$lib/server/db/maintenance';
import { agentBackend } from '$lib/server/agent/backend';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	try {
		const [status, gateway] = await Promise.all([getMaintenanceStatus(), agentBackend().health()]);
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
