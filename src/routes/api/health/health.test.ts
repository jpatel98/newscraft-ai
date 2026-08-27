import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ sql: vi.fn() }));
const gatewayMocks = vi.hoisted(() => ({ gatewayHealth: vi.fn() }));
const documentMocks = vi.hoisted(() => ({ getConversationDocumentService: vi.fn() }));

vi.mock('$lib/server/db', () => ({ sql: dbMocks.sql }));
vi.mock('$lib/server/agent/transport', () => ({ gatewayHealth: gatewayMocks.gatewayHealth }));
vi.mock('$lib/server/documents/runtime', () => ({
	getConversationDocumentService: documentMocks.getConversationDocumentService
}));

import { GET } from './+server';

const user = { id: 'account-a', email: 'editor@example.test', name: 'Editor', role: 'member' as const };

function hermesJson(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		service: 'newscraft-hermes-chat',
		capabilities: {
			browser: true,
			webResearch: true,
			webExtraction: { configured: true, tool: true, leadVerificationTool: true },
			webLeadVerification: { configured: true, tool: true, bounded: true },
			...overrides
		}
	};
}

function hermesHealth(json: unknown = hermesJson(), overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		requiredReady: true,
		webExtractionReady: true,
		providers: {
			browser: true,
			webResearch: true,
			webExtraction: true,
			webLeadVerification: true
		},
		status: 200,
		body: 'sensitive upstream body',
		url: 'https://user:password@example.test',
		json,
		service: 'newscraft-hermes-chat',
		...overrides
	};
}

function request(userValue: typeof user | null = user, search = '') {
	return {
		locals: { user: userValue },
		url: new URL(`http://localhost/api/health${search}`)
	} as any;
}

describe('NewsCraft health contract', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMocks.sql.mockResolvedValue([
			{ profiles: 'newsroom_profiles', documents: 'conversation_documents', pages: 'conversation_document_pages' }
		]);
		documentMocks.getConversationDocumentService.mockReturnValue({
			verifyCapability: vi.fn().mockResolvedValue(undefined)
		});
		gatewayMocks.gatewayHealth.mockResolvedValue(hermesHealth());
	});

	it('returns ready with separated authenticated component details', async () => {
		const response = await GET(request());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, state: 'ready', service: 'newscraft-ui' });
		expect(body.components.database).toMatchObject({ required: true, ok: true, state: 'ready' });
		expect(body.components.hermes).toMatchObject({ required: true, ok: true, state: 'ready', status: 200 });
		expect(body.components.documents).toMatchObject({ required: false, ok: true, state: 'ready' });
		expect(body.components.providers.browser).toMatchObject({ required: false, ok: true, state: 'ready' });
		expect(body.app).toMatchObject({ ok: true, capabilities: { documents: true } });
		expect(body.gateway).toMatchObject({ ok: true, status: 200, service: 'newscraft-hermes-chat' });
		expect(body.gateway).not.toHaveProperty('body');
		expect(body.gateway).not.toHaveProperty('url');
		expect(body.gateway).not.toHaveProperty('json');
	});

	it('keeps the public response redacted and aligned with HTTP readiness', async () => {
		const response = await GET(request(null, '?capabilities=1'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, state: 'ready', service: 'newscraft-ui' });
		expect(body).not.toHaveProperty('components');
		expect(body).not.toHaveProperty('app');
		expect(body).not.toHaveProperty('gateway');
		expect(dbMocks.sql).toHaveBeenCalledTimes(1);
	});

	it('reports optional documents and provider failures as degraded without failing required readiness', async () => {
		gatewayMocks.gatewayHealth.mockResolvedValue(
			hermesHealth(hermesJson({
				browser: false,
				webExtraction: { configured: false, tool: false, leadVerificationTool: false }
			}))
		);
		documentMocks.getConversationDocumentService.mockReturnValue({
			verifyCapability: vi.fn().mockRejectedValue(new Error('private document failure'))
		});

		const response = await GET(request());
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ ok: true, state: 'degraded' });
		expect(body.components.database).toMatchObject({ required: true, ok: true });
		expect(body.components.hermes).toMatchObject({ required: true, ok: true });
		expect(body.components.documents).toMatchObject({ required: false, ok: false, state: 'unavailable' });
		expect(body.components.providers.browser).toMatchObject({ required: false, ok: false, state: 'unavailable' });
		expect(body.components.providers.webExtraction).toMatchObject({ ok: false, state: 'unavailable' });
	});

	it('returns unavailable with a matching 503 when a required component fails', async () => {
		dbMocks.sql.mockRejectedValueOnce(new Error('postgres://user:secret@example.test/db'));
		gatewayMocks.gatewayHealth.mockResolvedValue(
			hermesHealth(null, {
				ok: false,
				requiredReady: false,
				status: 503,
				body: 'token=secret',
				url: 'https://user:password@example.test'
			})
		);

		const privateResponse = await GET(request());
		const privateBody = await privateResponse.json();
		const publicResponse = await GET(request(null, '?capabilities=1'));
		const publicBody = await publicResponse.json();

		expect(privateResponse.status).toBe(503);
		expect(privateBody).toMatchObject({ ok: false, state: 'unavailable' });
		expect(privateBody.components.database).toMatchObject({ ok: false, error: 'database_unavailable' });
		expect(JSON.stringify(privateBody)).not.toContain('postgres://');
		expect(JSON.stringify(privateBody)).not.toContain('secret');
		expect(publicResponse.status).toBe(503);
		expect(publicBody).toMatchObject({ ok: false, state: 'unavailable' });
		expect(publicBody).not.toHaveProperty('components');
	});
});
