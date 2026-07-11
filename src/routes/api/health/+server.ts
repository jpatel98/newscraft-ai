import { json } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { gatewayHealth } from '$lib/server/agent/transport';
import { getConversationDocumentService } from '$lib/server/documents/runtime';

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

let documentCapabilityCache: { ready: boolean; expiresAt: number } | null = null;

async function documentsReady(gatewayJson: unknown): Promise<boolean> {
	const now = Date.now();
	if (documentCapabilityCache && documentCapabilityCache.expiresAt > now) {
		return documentCapabilityCache.ready;
	}
	let ready = false;
	try {
		const [tables] = await sql<
			Array<{ profiles: string | null; documents: string | null; pages: string | null }>
		>`
			SELECT
				to_regclass('public.newsroom_profiles')::text AS profiles,
				to_regclass('public.conversation_documents')::text AS documents,
				to_regclass('public.conversation_document_pages')::text AS pages
		`;
		const gateway =
			gatewayJson && typeof gatewayJson === 'object'
				? (gatewayJson as { capabilities?: { documents?: boolean } })
				: null;
		if (tables?.profiles && tables.documents && tables.pages && gateway?.capabilities?.documents === true) {
			await getConversationDocumentService().verifyCapability();
			ready = true;
		}
	} catch {
		ready = false;
	}
	documentCapabilityCache = { ready, expiresAt: now + 30_000 };
	return ready;
}

export const GET = async ({ locals, url }) => {
	const [gateway, app] = await Promise.all([gatewayHealth(), appHealth()]);
	const ok = app.ok && gateway.ok;
	const documents = locals.user && ok ? await documentsReady(gateway.json) : false;
	const base = {
		ok,
		service: 'newscraft-ui',
		time: new Date().toISOString()
	};
	const capabilityProbe = url.searchParams.get('capabilities') === '1';
	return json(
		locals.user
			? { ...base, app: { ...app, capabilities: { documents } }, gateway }
			: base,
		{
			status: ok || (capabilityProbe && app.ok) ? 200 : 503,
			headers: { 'Cache-Control': 'no-store' }
		}
	);
};
