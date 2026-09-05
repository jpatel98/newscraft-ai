import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as chatStream } from '../../../routes/api/chat/stream/+server';
import { GET as exportConversation } from '../../../routes/api/conversations/[id]/export/+server';
import { POST as claimPartial } from '../../../routes/api/messages/[id]/claim-partial/+server';
import { POST as clearPartial } from '../../../routes/api/messages/[id]/clear-partial/+server';
import * as hermesTransport from '../agent/transport';
import { ensureMigrated, sql } from './index';
import {
	claimPartialAssistantMessage,
	finalizeResumedAssistantMessage,
	getMessages,
	getMessageById,
	parseContent
} from './conversations';
import * as conversationsDb from './conversations';
import { getMessageProvenance } from './message-provenance';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
type GatewayResponseFactory = (signal?: AbortSignal) => Response;
let activeGatewayResponse: GatewayResponseFactory | null = null;

describe.skipIf(!databaseUrl)('atomic assistant resume integration', () => {
	const accountId = `atomic-test-account-${Date.now()}`;
	const originalHermesUrl = process.env.NEWSCRAFT_HERMES_URL;
	const originalHermesToken = process.env.NEWSCRAFT_HERMES_API_TOKEN;
	const originalHermesTenantSecret = process.env.NEWSCRAFT_HERMES_TENANT_SECRET;
	const streamChatCompletionSpy = vi.spyOn(hermesTransport, 'streamChatCompletion');

	beforeAll(async () => {
		process.env.NEWSCRAFT_HERMES_URL = 'http://hermes.test';
		process.env.NEWSCRAFT_HERMES_API_TOKEN = 'test-hermes-token';
		process.env.NEWSCRAFT_HERMES_TENANT_SECRET = 'test-tenant-secret-0123456789012345';
		streamChatCompletionSpy.mockImplementation(async (_body, options = {}) => {
			const health = await hermesTransport.gatewayHealth();
			if (!health.ok) throw new Error(health.body || 'Hermes readiness failed.');
			if (!activeGatewayResponse) throw new Error('atomic stream fixture is not configured');
			return activeGatewayResponse(options.signal);
		});
		await ensureMigrated();
		const now = Date.now();
		await sql`
			INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES (${accountId}, ${`${accountId}@example.test`}, 'Atomic test', 'member', ${now}, ${now})
		`;
	});

	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${accountId}`;
		await sql.end({ timeout: 1 });
		if (originalHermesUrl === undefined) delete process.env.NEWSCRAFT_HERMES_URL;
		else process.env.NEWSCRAFT_HERMES_URL = originalHermesUrl;
		if (originalHermesToken === undefined) delete process.env.NEWSCRAFT_HERMES_API_TOKEN;
		else process.env.NEWSCRAFT_HERMES_API_TOKEN = originalHermesToken;
		if (originalHermesTenantSecret === undefined) delete process.env.NEWSCRAFT_HERMES_TENANT_SECRET;
		else process.env.NEWSCRAFT_HERMES_TENANT_SECRET = originalHermesTenantSecret;
		activeGatewayResponse = null;
		vi.unstubAllGlobals();
		streamChatCompletionSpy.mockRestore();
	});

	it('commits replacement content, provenance, reload, export, and rejects a stale route retry', async () => {
		const scenario = await seedPartial('replacement');
		const authoritative = 'Authoritative replacement with complete citation [1].';
		stubGateway(() => sseResponse([
			citationFrame(),
			['agent.answer.replace', JSON.stringify({ content: authoritative })],
			['message', '[DONE]']
		]));
		const response = await invokeResume(scenario);
		await response.text();
		await assertAuthoritative(scenario.conversationId, scenario.messageId, authoritative);
		await expectExport(scenario.conversationId, authoritative);

		await expect(invokeResume(scenario)).rejects.toMatchObject({ status: 400 });
		await assertAuthoritative(scenario.conversationId, scenario.messageId, authoritative);
	});

	it('does not persist a provider-labelled producer draft after authoritative replacement', async () => {
		const scenario = await seedPartial('provider-labelled-producer-draft');
		const rawDraft = '(pacific.example). Direct answer — story ideas (lead first). Budget Notes - HS 2026 Budget.';
		const authoritative =
			'## Latest producer roundup\n\n- Flooding closed several roads after heavy rain, and crews are assessing drainage capacity [1].';
		stubGateway(() => sseResponse([
			['response.output_text.delta', JSON.stringify({ delta: rawDraft })],
			citationFrame(),
			['agent.answer.replace', JSON.stringify({ content: authoritative })],
			['message', '[DONE]']
		]));

		const response = await invokeResume(scenario);
		await response.text();

		await assertAuthoritative(scenario.conversationId, scenario.messageId, authoritative);
		await expectExport(scenario.conversationId, authoritative);
		const provenance = await getMessageProvenance(scenario.messageId);
		const parsed = JSON.parse(provenance?.provenanceJson || '{}') as { stream?: { assistantChars?: number } };
		expect(parsed.stream?.assistantChars).toBe(authoritative.length);
		expect(parsed.stream?.assistantChars).not.toBe(rawDraft.length + authoritative.length);
	});

	it('persists a large safe replacement without applying the pending-construct bound to the answer', async () => {
		const scenario = await seedPartial('large-safe-replacement');
		const authoritative = 's'.repeat(262_144);
		stubGateway(() => sseResponse([
			['agent.answer.replace', JSON.stringify({ content: authoritative })],
			['message', '[DONE]']
		]));

		const response = await invokeResume(scenario);
		const streamed = await response.text();
		expect(streamed).toContain(authoritative);
		await assertAuthoritative(scenario.conversationId, scenario.messageId, authoritative);
		await expectExport(scenario.conversationId, authoritative);
	});

	it('rejects raw provider citation markers before stream, reload, and export persistence', async () => {
		const scenario = await seedPartial('provider-markers');
		const raw = 'Producer brief: confirmed facts remain attributed [99] and malformed [1.';
		const expected = 'Producer brief: confirmed facts remain attributed and malformed.';
		stubGateway(() => sseResponse([
			['agent.answer.replace', JSON.stringify({ content: raw })],
			['message', '[DONE]']
		]));

		const response = await invokeResume(scenario);
		const streamed = await response.text();
		expect(streamed).not.toContain('[99]');
		expect(streamed).not.toContain('[1.');
		await assertAuthoritative(scenario.conversationId, scenario.messageId, expected);
		await expectExport(scenario.conversationId, expected);
	});

	it('keeps split citation markers out of live SSE and matches durable reconciliation', async () => {
		const unknownScenario = await seedPartial('split-marker-unknown');
		stubGateway(() => sseResponse([
			['agent.answer.replace', JSON.stringify({ content: 'Claim [' })],
			['response.output_text.delta', JSON.stringify({ delta: '1].' })],
			['message', '[DONE]']
		]));
		const unknownResponse = await invokeResume(unknownScenario);
		const unknownStream = await unknownResponse.text();
		expect(unknownStream).not.toContain('Claim [1].');
		expect(unknownStream).toContain('Claim');
		expect(unknownStream).toContain('event: agent.answer.replace\ndata: {"content":"Claim."}');
		await assertAuthoritative(unknownScenario.conversationId, unknownScenario.messageId, 'Claim.');

		const knownScenario = await seedPartial('split-marker-known');
		stubGateway(() => sseResponse([
			[
				'agent.citations',
				JSON.stringify({
					citations: [{
						citationNumber: 1,
						title: 'Provided notes',
						url: 'newsroom://provided-notes/1',
						domain: 'provided notes',
						sourceType: 'user_document',
						supportingExcerpt: 'Claim.'
					}]
				})
			],
			['agent.answer.replace', JSON.stringify({ content: 'Claim [' })],
			['response.output_text.delta', JSON.stringify({ delta: '1].' })],
			['message', '[DONE]']
		]));
		const knownResponse = await invokeResume(knownScenario);
		const knownStream = await knownResponse.text();
		expect(knownStream).toContain('event: agent.answer.replace\ndata: {"content":"Claim "}');
		expect(knownStream).toContain('event: response.output_text.delta\ndata: {"delta":"[1]."}');
		await assertAuthoritative(knownScenario.conversationId, knownScenario.messageId, 'Claim [1].');
		await expectExport(knownScenario.conversationId, 'Claim [1].');
	});

	it('uses the route CAS contract for normal resumed replacement without duplication', async () => {
		const scenario = await seedPartial('delta');
		const expected = 'Partial draft for delta. resumed once.';
		stubGateway(() => sseResponse([
			['agent.answer.replace', JSON.stringify({ content: expected })],
			['message', '[DONE]']
		]));
		const response = await invokeResume(scenario);
		await response.text();

		await assertAuthoritative(scenario.conversationId, scenario.messageId, expected);
		await expectExport(scenario.conversationId, expected);
	});

	it('persists the complete replacement followed by every later delta exactly once', async () => {
		const scenario = await seedPartial('replacement-tail');
		const authoritative = 'Authoritative answer [1].';
		stubGateway(() => sseResponse([
			citationFrame(),
			['agent.answer.replace', JSON.stringify({ content: authoritative })],
			['response.output_text.delta', JSON.stringify({ delta: ' Tail one.' })],
			['response.output_text.delta', JSON.stringify({ delta: ' Tail two.' })],
			['message', '[DONE]']
		]));
		const response = await invokeResume(scenario);
		await response.text();

		const expected = `${authoritative} Tail one. Tail two.`;
		await assertAuthoritative(scenario.conversationId, scenario.messageId, expected);
		await expectExport(scenario.conversationId, expected);
		const provenance = await getMessageProvenance(scenario.messageId);
		const parsed = JSON.parse(provenance?.provenanceJson || '{}') as { stream?: { assistantChars?: number } };
		expect(parsed.stream?.assistantChars).toBe(expected.length);
	});

	it('reconciles a cancelled replacement stream once and rejects a retry after abort', async () => {
		const scenario = await seedPartial('replacement-abort');
		const authoritative = 'Authoritative answer [1].';
		stubGateway((signal) => hangingSseResponse([
			citationFrame(),
			['agent.answer.replace', JSON.stringify({ content: authoritative })],
			['response.output_text.delta', JSON.stringify({ delta: ' Tail after abort.' })]
		], signal));
		const response = await invokeResume(scenario);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const decoder = new TextDecoder();
		let streamed = '';
		for (let index = 0; index < 10 && !streamed.includes('Tail after abort.'); index += 1) {
			const next = await reader!.read();
			if (next.done) break;
			streamed += decoder.decode(next.value, { stream: true });
		}
		expect(streamed).toContain('Tail after abort.');
		await reader!.cancel();
		const expected = `${authoritative} Tail after abort.`;
		await waitForAuthoritative(scenario.messageId, expected);
		await assertAuthoritative(scenario.conversationId, scenario.messageId, expected);
		await expectExport(scenario.conversationId, expected);
		await expect(invokeResume(scenario)).rejects.toMatchObject({ status: 400 });
	});

	it('surfaces cancellation persistence failure and leaves the claimed row resumable', async () => {
		const scenario = await seedPartial('cancel-failure');
		stubGateway((signal) => hangingSseResponse([
			citationFrame(),
			['agent.answer.replace', JSON.stringify({ content: 'Authoritative answer before failure [1].' })],
			['response.output_text.delta', JSON.stringify({ delta: ' Tail before failure.' })]
		], signal));
		const finalizer = vi
			.spyOn(conversationsDb, 'finalizeResumedAssistantMessage')
			.mockRejectedValueOnce(new Error('temporary persistence failure'));
		try {
			const response = await invokeResume(scenario);
			const reader = response.body?.getReader();
			expect(reader).toBeDefined();
			const decoder = new TextDecoder();
			let streamed = '';
			for (let index = 0; index < 10 && !streamed.includes('Tail before failure.'); index += 1) {
				const next = await reader!.read();
				if (next.done) break;
				streamed += decoder.decode(next.value, { stream: true });
			}
			expect(streamed).toContain('Tail before failure.');
			await expect(reader!.cancel()).rejects.toThrow('temporary persistence failure');
			const row = await getMessageById(scenario.messageId);
			expect(row?.partial).toBe(1);
			expect(row?.resumeClaimedAt).toEqual(expect.any(Number));
			expect(parseContent(row?.content || '')).toBe('Partial draft for cancel-failure.');
			const provenance = await getMessageProvenance(scenario.messageId);
			expect(provenance).toBeUndefined();
		} finally {
			finalizer.mockRestore();
		}
	});

	it('uses the route CAS contract for gateway-failure fallback and persists it once', async () => {
		const scenario = await seedPartial('gateway-failure');
		stubGateway(() => new Response('temporarily unavailable', { status: 503, statusText: 'Unavailable' }));
		const response = await invokeResume(scenario);
		const streamed = await response.text();

		expect(streamed).toContain('couldn\'t reach the research service');
		const row = await getMessageById(scenario.messageId);
		expect(row?.partial).toBe(0);
		expect(parseContent(row?.content || '')).toContain('Partial draft for gateway-failure.');
		expect(parseContent(row?.content || '')).toContain('couldn\'t reach the research service');
		await assertProvenance(scenario.messageId);
		await expectExport(scenario.conversationId, String(parseContent(row?.content || '')));
	});

	it('keeps a crashed stream resumable, emits a safe partial terminal, and resumes once', async () => {
		const scenario = await seedPartial('crash');
		stubGateway(() => sseResponse([
			['response.output_text.delta', JSON.stringify({ delta: ' crashed fragment.' })],
			['response.failed', JSON.stringify({ error: { message: 'gateway stopped' } })]
		]));
		const crashed = await invokeResume(scenario);
		const crashedStream = await crashed.text();
		expect(crashedStream).toContain('crashed fragment.');
		expect(crashedStream).toContain('The research run stopped before it finished');
		const partial = await getMessageById(scenario.messageId);
		expect(partial?.partial).toBe(1);
		expect(partial?.resumeClaimedAt).toBeNull();
		expect(parseContent(partial?.content || '')).toContain('crashed fragment.');
		expect(parseContent(partial?.content || '')).toContain('The research run stopped before it finished');
		await assertProvenance(scenario.messageId);

		const recoveredAnswer = 'Recovered answer after crash.';
		stubGateway(() => sseResponse([
			['agent.answer.replace', JSON.stringify({ content: recoveredAnswer })],
			['message', '[DONE]']
		]));
		const recovered = await invokeResume(scenario);
		await recovered.text();
		const expected = recoveredAnswer;
		await assertAuthoritative(scenario.conversationId, scenario.messageId, expected);
		await expectExport(scenario.conversationId, expected);

		await expect(invokeResume(scenario)).rejects.toMatchObject({ status: 400 });
		await assertAuthoritative(scenario.conversationId, scenario.messageId, expected);
	});

	it('rejects a stale CAS owner without changing content or provenance', async () => {
		const scenario = await seedPartial('cas');
		const claimToken = await claimPartialAssistantMessage(scenario.messageId, scenario.conversationId);
		expect(claimToken).toEqual(expect.any(Number));
		await expect(invokeResume(scenario)).rejects.toMatchObject({ status: 409 });

		const stale = await finalizeResumedAssistantMessage({
			id: scenario.messageId,
			conversationId: scenario.conversationId,
			claimToken: (claimToken as number) + 1,
			mode: 'replace',
			content: 'Stale replacement must not commit.',
			toolCalls: null,
			provenanceJson: JSON.stringify({ stream: { answerText: 'stale' } }),
			partial: 0
		});
		expect(stale).toBeUndefined();
		const unchanged = await getMessageById(scenario.messageId);
		expect(unchanged).toMatchObject({
			content: 'Partial draft for cas.',
			partial: 1,
			resumeClaimedAt: claimToken
		});

		const committed = await finalizeResumedAssistantMessage({
			id: scenario.messageId,
			conversationId: scenario.conversationId,
			claimToken: claimToken as number,
			mode: 'replace',
			content: 'CAS owner replacement.',
			toolCalls: null,
			provenanceJson: JSON.stringify({ stream: { answerText: 'CAS owner replacement.' } }),
			partial: 0
		});
		expect(committed).toMatchObject({ content: 'CAS owner replacement.', partial: 0, resumeClaimedAt: null });
		await expectExport(scenario.conversationId, 'CAS owner replacement.');
	});

	it('discards only the active partial owner and rejects stale or duplicate discard attempts', async () => {
		const active = await seedPartial('discard-active');
		const activeToken = await invokeClaim(active);
		expect(activeToken).toEqual(expect.any(Number));
		expect(await getMessageById(active.messageId)).toMatchObject({ partial: 1, resumeClaimedAt: activeToken });
		const discarded = await invokeDiscard(active, activeToken as number);
		expect(discarded.status).toBe(200);
		await discarded.text();
		const discardedRow = await getMessageById(active.messageId);
		expect(discardedRow).toMatchObject({ partial: 0, resumeClaimedAt: null });
		await assertProvenance(active.messageId);
		await expectExport(active.conversationId, 'Partial draft for discard-active.');

		await expect(invokeDiscard(active, activeToken as number)).rejects.toMatchObject({ status: 409 });

		const stale = await seedPartial('discard-stale');
		const ownerToken = await invokeClaim(stale);
		expect(ownerToken).toEqual(expect.any(Number));
		await expect(invokeDiscard(stale, (ownerToken as number) + 1)).rejects.toMatchObject({ status: 409 });
		expect(await getMessageById(stale.messageId)).toMatchObject({
			partial: 1,
			resumeClaimedAt: ownerToken
		});
		const ownerDiscard = await invokeDiscard(stale, ownerToken as number);
		expect(ownerDiscard.status).toBe(200);
		await ownerDiscard.text();
		await expectExport(stale.conversationId, 'Partial draft for discard-stale.');
	});

	async function seedPartial(label: string): Promise<{ conversationId: string; messageId: string }> {
		const conversationId = `atomic-test-conversation-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const messageId = `atomic-test-message-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		await sql`
			INSERT INTO conversations (id, account_id, org_id, title, created_at, updated_at, pinned)
			VALUES (${conversationId}, ${accountId}, 'org_default', ${`Atomic ${label}`}, ${now}, ${now}, 0)
		`;
		await sql`
			INSERT INTO messages (id, conversation_id, role, content, tool_calls, partial, resume_claimed_at, created_at)
			VALUES (${`user-${messageId}`}, ${conversationId}, 'user', ${`Continue the ${label} answer.`}, NULL, 0, NULL, ${now + 1})
		`;
		await sql`
			INSERT INTO messages (id, conversation_id, role, content, tool_calls, partial, resume_claimed_at, created_at)
			VALUES (${messageId}, ${conversationId}, 'assistant', ${`Partial draft for ${label}.`}, 'old-metadata', 1, NULL, ${now + 2})
		`;
		return { conversationId, messageId };
	}

	function stubGateway(
		response: GatewayResponseFactory,
		options: { readiness?: () => Response } = {}
	): void {
		activeGatewayResponse = response;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown, init?: RequestInit) => {
				if (String(input).endsWith('/ready')) return options.readiness?.() ?? hermesReadyResponse();
				return new Response('unexpected atomic fixture fetch', { status: 500 });
			})
		);
	}

	function hermesReadyResponse(): Response {
		return new Response(
			JSON.stringify({
				ok: true,
				service: 'newscraft-hermes-chat',
				toolset: 'hermes-acp',
				tools: ['browser_navigate', 'browser_snapshot', 'web_search', 'web_extract', 'verify_this_lead'],
				runtime: { provider: 'fixture', model: 'hermes-fixture', endpointMode: 'explicit' },
				capabilities: {
					standard: true,
					browser: true,
					webResearch: true,
					webExtraction: { configured: true, tool: true, leadVerificationTool: true },
					webLeadVerification: { configured: true, tool: true, bounded: true },
					terminal: true,
					files: true,
					codeExecution: true,
					delegation: true,
					skills: true,
					memory: true,
					durableRuns: { configured: true, callback: true },
					accountIsolation: {
						tenantHeader: 'x-newscraft-tenant-key',
						contextLocalHome: true,
						stableTaskKey: true,
						persistentDockerWorkspace: true,
						isolatedBrowserProfiles: true
					}
				}
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}

	function citationFrame(excerpt = 'Authoritative fixture claim.'): [string, string] {
		return [
			'agent.citations',
			JSON.stringify({
				citations: [{
					citationNumber: 1,
					title: 'Authoritative fixture source',
					url: 'https://fixture.example/source',
					domain: 'fixture.example',
					publicationDate: '2026-09-01',
					sourceType: 'official',
					supportingExcerpt: excerpt
				}]
			})
		];
	}

	function sseResponse(frames: Array<[string, string]>): Response {
		// The transport spy above performs the current JSON readiness probe. These
		// frames are the post-normalization NewsCraft stream contract consumed by
		// the route, which keeps this test focused on atomic replacement behavior.
		const body = frames
			.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`)
			.join('');
		return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	}

	function hangingSseResponse(frames: Array<[string, string]>, signal?: AbortSignal): Response {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				for (const [event, data] of frames) {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				}
				signal?.addEventListener('abort', () => controller.close(), { once: true });
			}
		});
		return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	}

	async function invokeResume(scenario: { conversationId: string; messageId: string }): Promise<Response> {
		return chatStream({
			request: new Request('http://localhost/api/chat/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					conversation_id: scenario.conversationId,
					resume: true,
					message_id: scenario.messageId,
					trace_id: `integration-${Date.now()}`
				})
			}),
			locals: { user: { id: accountId } },
			getClientAddress: () => '127.0.0.1'
		} as never);
	}

	async function invokeDiscard(
		scenario: { conversationId: string; messageId: string },
		claimToken: number
	): Promise<Response> {
		return clearPartial({
			request: new Request(`http://localhost/api/messages/${scenario.messageId}/clear-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: scenario.conversationId, claim_token: claimToken })
			}),
			params: { id: scenario.messageId },
			locals: { user: { id: accountId } }
		} as never);
	}

	async function invokeClaim(scenario: { conversationId: string; messageId: string }): Promise<number> {
		const response = await claimPartial({
			request: new Request(`http://localhost/api/messages/${scenario.messageId}/claim-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: scenario.conversationId })
			}),
			params: { id: scenario.messageId },
			locals: { user: { id: accountId } }
		} as never);
		expect(response.status).toBe(200);
		return ((await response.json()) as { claim_token: number }).claim_token;
	}

	async function assertAuthoritative(conversationId: string, messageId: string, expected: string): Promise<void> {
		const messages = await getMessages(conversationId);
		expect(messages).toHaveLength(2);
		const row = messages.find((message) => message.id === messageId);
		expect(row).toMatchObject({ content: expected, partial: 0, resumeClaimedAt: null });
		expect(parseContent(row?.content || '')).toBe(expected);
		await assertProvenance(messageId);
	}

	async function assertProvenance(messageId: string): Promise<void> {
		const row = await getMessageProvenance(messageId);
		expect(row).toBeDefined();
		const rows = await sql`SELECT message_id FROM message_provenance WHERE message_id = ${messageId}`;
		expect(rows).toHaveLength(1);
		const parsed = JSON.parse(row?.provenanceJson || '{}') as {
			stream?: { assistantChars?: number; done?: boolean };
		};
		expect(parsed.stream?.assistantChars).toBeGreaterThan(0);
	}

	async function waitForAuthoritative(messageId: string, expected: string): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const row = await getMessageById(messageId);
			if (row?.partial === 0 && parseContent(row.content) === expected) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`timed out waiting for authoritative message ${messageId}`);
	}

	async function expectExport(conversationId: string, expected: string): Promise<void> {
		const response = await exportConversation({
			params: { id: conversationId },
			url: new URL(`http://localhost/api/conversations/${conversationId}/export?format=jsonl`),
			locals: { user: { id: accountId } }
		} as never);
		const messages = (await response.text())
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((line) => line.type === 'message');
		expect(messages).toHaveLength(2);
		expect(messages.find((line) => line.role === 'assistant')?.content).toBe(expected);
		const markdown = await exportConversation({
			params: { id: conversationId },
			url: new URL(`http://localhost/api/conversations/${conversationId}/export?format=md`),
			locals: { user: { id: accountId } }
		} as never);
		expect(await markdown.text()).toContain(expected);
	}
});
