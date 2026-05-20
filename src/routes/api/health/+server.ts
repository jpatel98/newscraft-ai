import { json } from '@sveltejs/kit';
import { appDbPath, sqliteClient } from '$lib/server/db';
import { gatewayHealth } from '$lib/server/hermes/transport';

function publicError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function appHealth() {
	try {
		const quickCheck = sqliteClient.prepare('PRAGMA quick_check').pluck().get() as string | undefined;
		return {
			ok: quickCheck === 'ok',
			dbPath: appDbPath,
			quickCheck: quickCheck ?? 'missing'
		};
	} catch (err) {
		return {
			ok: false,
			dbPath: appDbPath,
			error: publicError(err)
		};
	}
}

export const GET = async () => {
	const [gateway, app] = await Promise.all([gatewayHealth(), appHealth()]);
	const ok = app.ok && gateway.ok;
	return json(
		{
			ok,
			service: 'newscraft-ui',
			time: new Date().toISOString(),
			app,
			gateway
		},
		{
			status: ok ? 200 : 503,
			headers: { 'Cache-Control': 'no-store' }
		}
	);
};
