import { json } from '@sveltejs/kit';
import { gatewayHealth } from '$lib/server/hermes/transport';

export const GET = async () => {
	const gateway = await gatewayHealth();
	return json({ ok: true, gateway });
};
