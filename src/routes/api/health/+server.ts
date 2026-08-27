import { json, type RequestHandler } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { gatewayHealth } from '$lib/server/agent/transport';
import { getConversationDocumentService } from '$lib/server/documents/runtime';

type ComponentState = 'ready' | 'degraded' | 'unavailable' | 'unknown';

interface HealthComponent {
	required: boolean;
	ok: boolean | null;
	state: ComponentState;
	[key: string]: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function componentState(ok: boolean | null): ComponentState {
	if (ok === true) return 'ready';
	if (ok === false) return 'unavailable';
	return 'unknown';
}

function providerReady(value: unknown, requiredFields: string[] = []): boolean | null {
	if (typeof value === 'boolean') return value;
	const object = objectValue(value);
	if (!object || typeof object.configured !== 'boolean') return null;
	return object.configured && requiredFields.every((field) => object[field] === true);
}

function providerComponent(value: unknown, requiredFields: string[] = []): HealthComponent {
	const ok = providerReady(value, requiredFields);
	return { required: false, ok, state: componentState(ok) };
}

function providerComponents(gatewayJson: unknown): Record<string, HealthComponent> {
	const capabilities = objectValue(objectValue(gatewayJson)?.capabilities);
	return {
		browser: providerComponent(capabilities?.browser),
		webResearch: providerComponent(capabilities?.webResearch),
		webExtraction: providerComponent(capabilities?.webExtraction, ['tool', 'leadVerificationTool']),
		webLeadVerification: providerComponent(capabilities?.webLeadVerification, ['tool', 'bounded'])
	};
}

async function appHealth(): Promise<{ ok: boolean; database: 'postgres' }> {
	try {
		await sql`SELECT 1`;
		return { ok: true, database: 'postgres' };
	} catch {
		return { ok: false, database: 'postgres' };
	}
}

/**
 * Check the app-owned document capability. This does not depend on Hermes:
 * document storage is an app database capability, not a required gateway
 * readiness signal.
 */
async function documentsReady(): Promise<boolean> {
	try {
		const [tables] = await sql<
			Array<{ profiles: string | null; documents: string | null; pages: string | null }>
		>`
			SELECT
				to_regclass('public.newsroom_profiles')::text AS profiles,
				to_regclass('public.conversation_documents')::text AS documents,
				to_regclass('public.conversation_document_pages')::text AS pages
		`;
		if (!tables?.profiles || !tables.documents || !tables.pages) return false;
		await getConversationDocumentService().verifyCapability();
		return true;
	} catch {
		return false;
	}
}

function gatewayDetails(gateway: Awaited<ReturnType<typeof gatewayHealth>>): HealthComponent {
	return {
		required: true,
		ok: gateway.ok,
		state: componentState(gateway.ok),
		status: gateway.status,
		service: gateway.service
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	const [gateway, app] = await Promise.all([gatewayHealth(), appHealth()]);
	const requiredReady = app.ok && gateway.ok;
	const documents = locals.user && app.ok ? await documentsReady() : false;
	const providers = providerComponents(gateway.json);
	const optionalDegraded =
		Boolean(locals.user) &&
		(!documents || Object.values(providers).some((component) => component.ok === false));
	const state: 'ready' | 'degraded' | 'unavailable' = !requiredReady
		? 'unavailable'
		: optionalDegraded
			? 'degraded'
			: 'ready';
	const base = {
		ok: requiredReady,
		service: 'newscraft-ui',
		state,
		time: new Date().toISOString()
	};

	if (!locals.user) {
		return json(base, {
			status: requiredReady ? 200 : 503,
			headers: { 'Cache-Control': 'no-store' }
		});
	}

	const authenticatedDetails = {
		components: {
			database: {
				required: true,
				ok: app.ok,
				state: componentState(app.ok),
				backend: app.database,
				...(!app.ok ? { error: 'database_unavailable' } : {})
			},
			hermes: gatewayDetails(gateway),
			documents: {
				required: false,
				ok: documents,
				state: componentState(documents),
				capability: 'conversation_documents'
			},
			providers
		},
		// Keep the small compatibility surface used by the document client and
		// existing release checks. Raw gateway bodies and URLs stay server-only.
		app: {
			ok: app.ok,
			database: app.database,
			capabilities: { documents }
		},
		gateway: gatewayDetails(gateway)
	};

	return json(
		{ ...base, ...authenticatedDetails },
		{
			status: requiredReady ? 200 : 503,
			headers: { 'Cache-Control': 'no-store' }
		}
	);
};
