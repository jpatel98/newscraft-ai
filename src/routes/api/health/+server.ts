import { json } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { gatewayHealth } from '$lib/server/agent/transport';

function publicError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function appHealth() {
	try {
		await sql`SELECT 1`;
		return {
			ok: true,
			database: 'postgres'
		};
	} catch (err) {
		return {
			ok: false,
			database: 'postgres',
			error: publicError(err)
		};
	}
}

export const GET = async ({ locals }) => {
	const [gateway, app] = await Promise.all([gatewayHealth(), appHealth()]);
	const ok = app.ok && gateway.ok;
	const base = {
		ok,
		service: 'newscraft-ui',
		time: new Date().toISOString()
	};
	return json(
		locals.user ? { ...base, app, gateway } : base,
		{
			status: ok ? 200 : 503,
			headers: { 'Cache-Control': 'no-store' }
		}
	);
};
