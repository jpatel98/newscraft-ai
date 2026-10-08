import type { ConversationContext } from '@newscraft/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ownedReadiness from './fixtures/owned-readiness.json';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
	agentFetch,
	buildHermesRunInput,
	cancelDurableHermesRun,
	describeGatewayError,
	deriveHermesTenantKey,
	deriveSessionId,
	gatewayHealth,
	HermesDurableOverloadError,
	normalizeHermesSse,
	startDurableHermesRun,
	type AgentMessage
} from './transport';

function aguiStream(...events: Array<Record<string, unknown>>): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' }
	});
}

function isolationReadyResponse(
	capabilityOverrides: Record<string, unknown> = {},
	toolProviderOverrides: Record<string, unknown> = {}
): Response {
	return new Response(
		JSON.stringify({
			ok: true,
			service: 'newscraft-agent',
			toolset: 'newscraft-agent',
			processInstanceId: 'a'.repeat(32),
			tools: [
				'browser_navigate',
				'browser_snapshot',
				'web_search',
				'web_extract',
				'verify_this_lead',
				'terminal',
				'process',
				'read_file',
				'write_file',
				'patch',
				'execute_code',
				'delegate_task',
				'skills_list',
				'skill_view',
				'skill_manage',
				'memory',
				'cronjob'
			],
			runtime: { provider: 'openai', model: 'gpt-5-mini', endpointMode: 'explicit', apiMode: 'responses', orchestration: 'newscraft' },
			toolProviders: {
				webSearch: { configured: true },
				webExtract: { configured: true },
				leadVerification: { configured: true },
				browser: { configured: true },
				...toolProviderOverrides
			},
			capabilities: {
				standard: true,
				boundedLoop: { configured: true, cancellation: true, stepBudget: true, timeBudget: true, costBudget: false },
				accountIsolation: {
					tenantHeader: 'x-newscraft-tenant-key',
					contextLocalHome: true,
					stableTaskKey: true,
					ownedRunState: true,
					conversationWorkspace: true,
					isolatedBrowserProfiles: true
				},
				browser: true,
				webResearch: true,
				webExtraction: {
					configured: true,
					backend: 'newscraft-local',
					archiveProvider: 'wayback',
					tool: true,
					leadVerificationTool: true
				},
				webLeadVerification: { configured: true, tool: true, bounded: true },
				terminal: true,
				files: true,
				codeExecution: true,
				delegation: true,
				skills: true,
				memory: true,
				durableRuns: { configured: true, callback: true },
				...capabilityOverrides
			}
		}),
		{ status: 200 }
	);
}

function retrievalMarker(overrides: Record<string, unknown> = {}): string {
	const value = {
		backend: 'newscraft-local',
		originalUrl: 'https://cbc.ca/news/story',
		retrievedUrl: 'https://cbc.ca/news/story',
		retrievalMode: 'live',
		evidenceStatus: 'accepted',
		pageTimestamp: '2026-08-10T12:00:00Z',
		publishedAt: '2026-08-10T12:00:00Z',
		updatedAt: null,
		requestCount: 1,
		...overrides
	};
	return `<!-- newscraft-retrieval:v1:${Buffer.from(JSON.stringify(value)).toString('base64url')} -->`;
}

describe('Hermes chat transport', () => {
	const originalUrl = process.env.NEWSCRAFT_HERMES_URL;
	const originalToken = process.env.NEWSCRAFT_HERMES_API_TOKEN;
	const originalTenantSecret = process.env.NEWSCRAFT_HERMES_TENANT_SECRET;

	beforeEach(() => {
		vi.stubEnv('NEWSCRAFT_AGENT_URL', '');
		vi.stubEnv('NEWSCRAFT_AGENT_API_TOKEN', '');
		vi.stubEnv('NEWSCRAFT_AGENT_TENANT_SECRET', '');
		process.env.NEWSCRAFT_HERMES_URL = 'https://hermes.test/';
		process.env.NEWSCRAFT_HERMES_API_TOKEN = 'test-hermes-token';
		process.env.NEWSCRAFT_HERMES_TENANT_SECRET = 'test-tenant-secret-0123456789012345';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		if (originalUrl === undefined) delete process.env.NEWSCRAFT_HERMES_URL;
		else process.env.NEWSCRAFT_HERMES_URL = originalUrl;
		if (originalToken === undefined) delete process.env.NEWSCRAFT_HERMES_API_TOKEN;
		else process.env.NEWSCRAFT_HERMES_API_TOKEN = originalToken;
		if (originalTenantSecret === undefined) delete process.env.NEWSCRAFT_HERMES_TENANT_SECRET;
		else process.env.NEWSCRAFT_HERMES_TENANT_SECRET = originalTenantSecret;
	});

	it('keeps the private conversation workspace across prompt edits and output transforms', () => {
		const messages: AgentMessage[] = [
			{ role: 'system', content: 'Use newsroom rules.' },
			{ role: 'user', content: 'Research this.' },
			{ role: 'assistant', content: 'Older answer.' },
			{ role: 'user', content: 'Later turn.' }
		];

		expect(deriveSessionId(messages, 'account:conversation')).toBe(
			deriveSessionId([...messages], 'account:conversation')
		);
		expect(deriveSessionId(messages, 'account:conversation')).not.toBe(deriveSessionId(messages));
		expect(deriveSessionId([
			{ role: 'system', content: 'Updated newsroom rules.' },
			...messages.slice(1)
		], 'account:conversation')).toBe(deriveSessionId(messages, 'account:conversation'));
		expect(deriveSessionId([
			{ role: 'assistant', content: 'Older answer.' },
			{ role: 'user', content: 'Make this a producer brief.' }
		], 'account:conversation')).toBe(deriveSessionId(messages, 'account:conversation'));
		expect(deriveSessionId(messages, 'other-account:conversation')).not.toBe(deriveSessionId(messages, 'account:conversation'));
		expect(deriveSessionId(messages, 'account:other-conversation')).not.toBe(deriveSessionId(messages, 'account:conversation'));
	});

	it('keeps prior citations resolvable and numbers attached documents after them', () => {
		const priorCitation = {
			citationNumber: 3,
			title: 'Prior verified source',
			url: 'https://example.test/prior',
			domain: 'example.test',
			publicationDate: '2026-08-19',
			sourceType: 'primary' as const,
			supportingExcerpt: 'A verified statement from the prior answer.'
		};
		const built = buildHermesRunInput(
			{
				messages: [
					{ role: 'assistant', content: 'The prior finding is supported by [3].' },
					{ role: 'user', content: 'Which source supports that finding?' }
				],
				documents: [
					{
						id: 'document-a',
						filename: 'notes.pdf',
						pageCount: 1,
						downloadUrl: '/api/documents/document-a',
						pages: [{ pageNumber: 1, text: 'A separate document statement.' }]
					}
				]
			},
			'thread-a',
			'run-a',
			{ seededCitations: [priorCitation] }
		);

		expect(built.seededCitations).toEqual([
			priorCitation,
			expect.objectContaining({ citationNumber: 4, title: 'notes.pdf, page 1' })
		]);
		expect(built.input.forwardedProps?.citationStartNumber).toBe(5);
	});

	it('carries corrections and prior evidence once without a compatibility prompt', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'transform',
			currentTurn: {
				content: 'Use the corrected branch count.',
				resolvedRequest: 'Use the corrected branch count.',
				operation: 'send',
				researchRequired: false
			},
			claimStates: [{ text: 'Three branches', status: 'corrected', correction: 'Two branches' }],
			lastSourceBackedAnswer: {
				messageId: 'prior',
				content: 'The pilot begins Monday. [1]',
				citations: [{ citationNumber: 1, title: 'Council notice', url: 'https://example.test/notice',
					domain: 'example.test', publicationDate: '2026-09-13', sourceType: 'official',
					supportingExcerpt: 'The pilot begins Monday.' }]
			}
		};
		const built = buildHermesRunInput({
			messages: [{ role: 'user', content: context.currentTurn!.content }],
			conversation_context: context
		}, 'thread-context', 'run-context');
		const entries = built.input.context.filter((entry) => entry.description === 'Conversation context');
		expect(entries).toHaveLength(1);
		expect(JSON.parse(entries[0].value)).toEqual(context);
		expect(built.input.messages).toHaveLength(1);
		expect(JSON.stringify(built.input.messages)).not.toContain('compatibility');
	});

	it('returns the Hermes cancellation result for durable recovery decisions', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ accepted: true, state: 'not_running' }), {
					status: 202,
					headers: { 'content-type': 'application/json' }
				})
			)
		);

		await expect(cancelDurableHermesRun('account-a', 'run-1')).resolves.toEqual({
			state: 'not_running'
		});
	});

	it('carries one server trace through the durable start request and input', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
		vi.stubGlobal('fetch', fetchMock);
		const built = buildHermesRunInput(
			{ messages: [{ role: 'user', content: 'A local test request.' }] },
			'thread-a',
			'run-a',
			{ traceId: 'trace_12345678' }
		);

		await startDurableHermesRun({
			runId: 'run-a',
			accountId: 'account-a',
			tenantKey: 'tenant-key-a',
			input: built.input,
			seededCitations: built.seededCitations,
			traceId: 'trace_12345678'
		});

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
		const body = JSON.parse(init.body as string) as { trace_id: string; input: { trace_id: string } };
		expect(init.headers).toMatchObject({
			'x-request-id': 'trace_12345678',
			'x-trace-id': 'trace_12345678'
		});
		expect(body.trace_id).toBe('trace_12345678');
		expect(body.input.trace_id).toBe('trace_12345678');
	});

	it('keeps legacy trace-free durable starts trace-free', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
		vi.stubGlobal('fetch', fetchMock);
		const input = {
			threadId: 'thread-a',
			runId: 'run-a',
			state: { newscraftSources: [] },
			messages: [],
			tools: [],
			context: [],
			forwardedProps: {}
		} as any;

		await startDurableHermesRun({
			runId: 'run-a',
			accountId: 'account-a',
			tenantKey: 'tenant-key-a',
			input,
			seededCitations: []
		});

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
		const body = JSON.parse(init.body as string) as Record<string, unknown> & { input: Record<string, unknown> };
		expect(init.headers).not.toHaveProperty('x-trace-id');
		expect(body).not.toHaveProperty('trace_id');
		expect(body.input).not.toHaveProperty('trace_id');
	});

	it('rejects a durable trace that does not match the saved input', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const built = buildHermesRunInput(
			{ messages: [{ role: 'user', content: 'A local test request.' }] },
			'thread-a',
			'run-a',
			{ traceId: 'trace_12345678' }
		);

		await expect(
			startDurableHermesRun({
				runId: 'run-a',
				accountId: 'account-a',
				tenantKey: 'tenant-key-a',
				input: built.input,
				seededCitations: built.seededCitations,
				traceId: 'trace_87654321'
			})
		).rejects.toThrow('trace binding');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('keeps durable overload machine-readable for the persisted failure path', async () => {
		const fetchMock = vi.fn().mockImplementation(
			() => new Response(JSON.stringify({ code: 'overloaded', detail: 'safe capacity message' }), { status: 429 })
		);
		vi.stubGlobal('fetch', fetchMock);
		const built = buildHermesRunInput(
			{ messages: [{ role: 'user', content: 'A local test request.' }] },
			'thread-a',
			'run-a'
		);

		await expect(
			startDurableHermesRun({
				runId: 'run-a',
				accountId: 'account-a',
				tenantKey: 'tenant-key-a',
				input: built.input,
				seededCitations: built.seededCitations,
				traceId: built.input.trace_id
			})
		).rejects.toBeInstanceOf(HermesDurableOverloadError);
		await expect(
			startDurableHermesRun({
				runId: 'run-a',
				accountId: 'account-a',
				tenantKey: 'tenant-key-a',
				input: built.input,
				seededCitations: built.seededCitations,
				traceId: built.input.trace_id
			})
		).rejects.toMatchObject({ code: 'overloaded' });
	});

	it('treats extracted pages as read sources but not as numbered citation authority', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"type":"TOOL_CALL_START","toolCallId":"call-1","toolCallName":"web_extract"}\n\n' +
							`data: {"type":"TOOL_CALL_RESULT","toolCallId":"call-1","content":${JSON.stringify(JSON.stringify({ results: [{ url: 'https://cbc.ca/news/story', title: 'CBC story', content: `The city confirmed the closure. ${retrievalMarker()}` }] }))}}\n\n` +
							'data: {"type":"TOOL_CALL_END","toolCallId":"call-1"}\n\n'
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('event: agent.tool.progress');
		expect(text).toContain('event: agent.source.read');
		expect(text).toContain('"verified":true');
		expect(text).toContain('"publishedAt":"2026-08-10T12:00:00Z"');
		expect(text).not.toContain('event: agent.citations');
	});

	it('normalizes the bounded verify-this-lead tool as a verified source', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: ' +
							JSON.stringify({
								type: 'TOOL_CALL_RESULT',
								toolCallId: 'call-verify',
								toolCallName: 'verify_this_lead',
								content: JSON.stringify({
									operation: 'verify_this_lead',
									results: [
										{
											url: 'https://cbc.ca/news/story',
											title: 'CBC story',
											content: `The city confirmed the closure. ${retrievalMarker()}`
										}
									]
								})
							}) +
							'\n\n'
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('event: agent.source.read');
		expect(text).toContain('"publishedAt":"2026-08-10T12:00:00Z"');
	});

	it('keeps a transit source date separate from its retrieval time', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				const content = `The transit agency published a service plan. ${retrievalMarker({
					originalUrl: 'https://transit.example.test/service-plan',
					retrievedUrl: 'https://transit.example.test/service-plan',
					pageTimestamp: '2026-05-30T13:00:00Z',
					publishedAt: '2026-05-30T13:00:00Z',
					retrievalTime: '2026-05-31T21:00:00Z'
				})}`;
				const event = {
					type: 'TOOL_CALL_RESULT',
					toolCallId: 'call-transit',
					toolCallName: 'verify_this_lead',
					content: JSON.stringify({
						operation: 'verify_this_lead',
						results: [
							{
								url: 'https://transit.example.test/service-plan',
								title: 'Transit service plan',
								content
							}
						]
					})
				};
				controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		const sourceFrame = text.slice(text.indexOf('event: agent.source.read'));
		expect(sourceFrame).toContain('"publishedAt":"2026-05-30T13:00:00Z"');
		expect(sourceFrame).toContain('"retrievalTime":"2026-05-31T21:00:00Z"');
		expect(sourceFrame).not.toContain('"publishedAt":"2026-05-31T21:00:00Z"');
	});

	it('does not promote an Aomori-style recorded source after Hermes rejects its retrieval', async () => {
		const rejectedUrl = 'https://example.test/japan-earthquake';
		const officialUrl = 'https://www.jma.go.jp/bosai/map.html#contents=earthquake_map';
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				const events = [
					{
						type: 'TOOL_CALL_RESULT',
						toolCallId: 'call-aomori',
						toolCallName: 'verify_this_lead',
						content: JSON.stringify({
							operation: 'verify_this_lead',
							results: [
								{
									url: rejectedUrl,
									title: 'Access denied',
									content: retrievalMarker({
										originalUrl: rejectedUrl,
										retrievedUrl: rejectedUrl,
										evidenceStatus: 'rejected',
										rejectionReason: 'live_blocked_http_403',
										pageTimestamp: null,
										publishedAt: null,
										updatedAt: null
									})
								}
							]
						})
					},
					{
						type: 'STATE_SNAPSHOT',
						snapshot: {
							newscraftSources: [
								{
									citationNumber: 1,
									title: 'Earthquake Information',
									url: officialUrl,
									publicationDate: '2026-07-29T16:42:00Z',
									sourceType: 'official',
									supportingExcerpt: 'A magnitude 4.7 earthquake occurred east of Aomori Prefecture.'
								},
								{
									citationNumber: 2,
									title: 'Access denied',
									url: rejectedUrl,
									publicationDate: '2026-07-29T16:49:00Z',
									sourceType: 'news_report',
									supportingExcerpt: 'The candidate source could not be read.'
								}
							]
						}
					}
				];
				controller.enqueue(
					new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text.match(/event: agent\.source\.read/g)).toHaveLength(1);
		expect(text).toContain(`"url":"${officialUrl}"`);
		expect(text).toContain('"citationNumber":1');
		expect(text).not.toContain('"citationNumber":2');
	});

	it('keeps the original URL as citation identity after an archived extraction', async () => {
		const original = 'https://cbc.ca/news/story';
		const archived = 'https://web.archive.org/web/20260812120000/https://cbc.ca/news/story';
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: ' +
							JSON.stringify({
								type: 'TOOL_CALL_RESULT',
								toolCallId: 'call-archive',
								toolCallName: 'web_extract',
								content: JSON.stringify({
									results: [
										{
											url: original,
											title: 'Archived CBC story',
											content: `The city confirmed the closure after the live page was blocked. ${retrievalMarker({
												originalUrl: original,
												retrievedUrl: archived,
												archivedUrl: archived,
												retrievalMode: 'archive',
												fallbackReason: 'live_blocked_http_403',
												captureTimestamp: '2026-08-12T12:00:00Z',
												requestCount: 3
											})}`
										}
									]
								})
							}) +
							'\n\n' +
							'data: ' +
							JSON.stringify({
								type: 'STATE_SNAPSHOT',
								snapshot: {
									newscraftSources: [
										{
											citationNumber: 1,
											title: 'Archived CBC story',
											url: archived,
								publicationDate: '2026-08-01',
											sourceType: 'news_report',
											supportingExcerpt: 'The city confirmed the closure.'
										}
									]
								}
							}) +
							'\n\n'
						));
					controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('NewsCraft read the Wayback copy after the live page was blocked.');
		expect(text).toContain('"url":"https://cbc.ca/news/story"');
		expect(text).toContain('"archivedUrl":"https://web.archive.org/web/20260812120000/https://cbc.ca/news/story"');
		expect(text).toContain('"fallbackReason":"live_blocked_http_403"');
		expect(text).toContain('"publishedAt":"2026-08-10T12:00:00Z"');
		expect(text).toContain('event: agent.citations');
	});

	it('keeps recorded source excerpts readable and bounded', async () => {
		const excerpt =
			'The city confirmed the closure after the direct page read. ' +
			'Officials gave the public an updated schedule. '.repeat(100);
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${JSON.stringify({
							type: 'STATE_SNAPSHOT',
							snapshot: {
								newscraftSources: [
									{
										citationNumber: 1,
										title: 'City closure update',
										url: 'https://city.example.test/closure',
										publicationDate: '2026-08-12',
										sourceType: 'official',
										supportingExcerpt: excerpt
									}
								]
							}
						})}\n\n`
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		const match = text.match(/"supportingExcerpt":"([^"]*)"/);
		expect(match?.[1]).toBeDefined();
		expect(match?.[1]).toContain('The city confirmed the closure');
		expect(match?.[1]?.length).toBeLessThanOrEqual(1_200);
	});

	it('treats a standard Hermes browser read as a source but not as numbered citation authority', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"type":"TOOL_CALL_START","toolCallId":"browser-1","toolCallName":"browser_navigate"}\n\n' +
							'data: {"type":"TOOL_CALL_RESULT","toolCallId":"browser-1","content":"{\\"success\\":true,\\"url\\":\\"https://www.cbc.ca/news/story\\",\\"title\\":\\"CBC story\\",\\"snapshot\\":\\"The city confirmed the closure on Monday.\\"}"}\n\n' +
							'data: {"type":"TOOL_CALL_END","toolCallId":"browser-1"}\n\n'
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('event: agent.source.read');
		expect(text).toContain('NewsCraft read this page with its browser.');
		expect(text).not.toContain('event: agent.citations');
	});

	it('uses Hermes state records as the exact citation number-to-source map', async () => {
		const cbc = {
			citationNumber: 1,
			title: 'CBC story',
			url: 'https://www.cbc.ca/news/canada/story',
			publicationDate: '2026-08-12',
			sourceType: 'news_report',
			supportingExcerpt: 'Officials confirmed the closure on Tuesday.'
		};
		const ctv = {
			citationNumber: 2,
			title: 'CTV story',
			url: 'https://www.ctvnews.ca/canada/story',
			publicationDate: '2026-08-12',
			sourceType: 'news_report',
			supportingExcerpt: 'The airline announced the change on Tuesday.'
		};
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						[{
							type: 'STATE_SNAPSHOT',
							snapshot: { newscraftSources: [cbc] }
						}, {
							type: 'STATE_SNAPSHOT',
							snapshot: { newscraftSources: [cbc, ctv] }
						}, {
							type: 'TEXT_MESSAGE_START',
							messageId: 'answer'
						}, {
							type: 'TEXT_MESSAGE_CONTENT',
							messageId: 'answer',
							delta: 'CBC reported the closure [1]. CTV reported the airline change [2].'
						}, {
							type: 'TEXT_MESSAGE_END',
							messageId: 'answer'
						}, { type: 'RUN_FINISHED' }]
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join('')
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text.match(/event: agent\.citations/g)).toHaveLength(2);
		expect(text).toContain('"citationNumber":1');
		expect(text).toContain('"url":"https://www.cbc.ca/news/canada/story"');
		expect(text).toContain('"citationNumber":2');
		expect(text).toContain('"url":"https://www.ctvnews.ca/canada/story"');
		expect(text.match(/Officials confirmed the closure on Tuesday\./g)).toHaveLength(1);
		expect(text).toContain('CBC reported the closure [1]. CTV reported the airline change [2].');
	});

	it('rejects a second source that reuses an assigned citation number', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"type":"STATE_SNAPSHOT","snapshot":{"newscraftSources":[' +
							'{"citationNumber":1,"title":"CBC","url":"https://cbc.ca/one","publicationDate":null,"sourceType":"news_report","supportingExcerpt":"First source."},' +
							'{"citationNumber":1,"title":"CTV","url":"https://ctvnews.ca/two","publicationDate":null,"sourceType":"news_report","supportingExcerpt":"Second source."}' +
							']}}\n\n'
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('https://cbc.ca/one');
		expect(text).not.toContain('https://ctvnews.ca/two');
	});

	it('keeps the requested page when a timed-out navigation is followed by a readable snapshot', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"type":"TOOL_CALL_START","toolCallId":"browser-1","toolCallName":"browser_navigate"}\n\n' +
							'data: {"type":"TOOL_CALL_ARGS","toolCallId":"browser-1","delta":"{\\"url\\":\\"https://apnews.com/article/story\\"}"}\n\n' +
							'data: {"type":"TOOL_CALL_RESULT","toolCallId":"browser-1","content":"{\\"success\\":false,\\"error\\":\\"Operation timed out.\\"}"}\n\n' +
							'data: {"type":"TOOL_CALL_END","toolCallId":"browser-1"}\n\n' +
							'data: {"type":"TOOL_CALL_START","toolCallId":"browser-2","toolCallName":"browser_snapshot"}\n\n' +
							'data: {"type":"TOOL_CALL_RESULT","toolCallId":"browser-2","content":"{\\"success\\":true,\\"snapshot\\":\\"Officials confirmed the evacuation order.\\"}"}\n\n' +
							'data: {"type":"TOOL_CALL_END","toolCallId":"browser-2"}\n\n'
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('event: agent.source.read');
		expect(text).toContain('"url":"https://apnews.com/article/story"');
		expect(text).not.toContain('event: agent.citations');
	});

	it('does not expose the legacy agent HTTP proxy', async () => {
		await expect(agentFetch('/api/jobs')).rejects.toThrow('Legacy agent-job transport is disabled');
	});

	it('keeps inter-tool narration out of the final answer', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"type":"TEXT_MESSAGE_START","messageId":"narration"}\n\n' +
							'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"narration","delta":"I will search now."}\n\n' +
							'data: {"type":"TEXT_MESSAGE_END","messageId":"narration"}\n\n' +
							'data: {"type":"TOOL_CALL_START","toolCallId":"search-1","toolCallName":"web_search"}\n\n' +
							'data: {"type":"TOOL_CALL_END","toolCallId":"search-1"}\n\n' +
							'data: {"type":"TEXT_MESSAGE_START","messageId":"answer"}\n\n' +
							'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"Here is the result."}\n\n' +
							'data: {"type":"TEXT_MESSAGE_END","messageId":"answer"}\n\n' +
							'data: {"type":"RUN_FINISHED"}\n\n'
					)
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('event: agent.answer.replace');
		expect(text).toContain('Here is the result.');
		expect(text).not.toContain('I will search now.');
	});

	it('preserves a clear Hermes stream failure', async () => {
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode('data: {"type":"RUN_ERROR","message":"Hermes job failed."}\n\n')
				);
				controller.close();
			}
		});

		const text = await new Response(normalizeHermesSse(source)).text();
		expect(text).toContain('event: response.failed');
		expect(text).toContain('Hermes job failed.');
	});

	it('accepts the actual owned-service research-only readiness contract', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ownedReadiness), { status: 200 })));
		await expect(gatewayHealth()).resolves.toMatchObject({ ok: true, requiredReady: true, webExtractionReady: true });
		expect(ownedReadiness.capabilities.terminal).toBe(false);
		expect(ownedReadiness.capabilities.browser).toBe(false);
	});

	it('reports ready for the standard Hermes capability set', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					service: 'newscraft-agent',
					toolset: 'newscraft-agent',
						tools: ['web_search', 'verify_this_lead', 'browser_navigate', 'browser_snapshot', 'terminal'],
					runtime: {
						provider: 'openai',
						model: 'gpt-5-mini',
						endpointMode: 'explicit', apiMode: 'responses', orchestration: 'newscraft'
					},
						capabilities: {
							standard: true,
				boundedLoop: { configured: true, cancellation: true, stepBudget: true, timeBudget: true, costBudget: false },
							accountIsolation: {
								tenantHeader: 'x-newscraft-tenant-key',
								contextLocalHome: true,
								stableTaskKey: true,
								ownedRunState: true,
					conversationWorkspace: true,
								isolatedBrowserProfiles: true
							},
							browser: true,
						webResearch: true,
						webExtraction: {
							configured: true,
							backend: 'newscraft-local',
							archiveProvider: 'wayback',
							tool: true,
							leadVerificationTool: true
						},
				webLeadVerification: { configured: true, tool: true, bounded: true },
				terminal: true,
				files: true,
				codeExecution: true,
				delegation: true,
				skills: true,
				memory: true,
				durableRuns: { configured: true, callback: true }
			}
				}),
				{ status: 200 }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toMatchObject({
			ok: true,
			status: 200,
			service: 'newscraft-agent',
			url: 'https://hermes.test'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://hermes.test/ready',
			expect.objectContaining({
				headers: expect.objectContaining({ 'x-hermes-session-token': 'test-hermes-token' })
			})
		);
	});

	it('keeps optional provider failures separate from required Hermes readiness', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				isolationReadyResponse({
					browser: false,
					webResearch: false,
					webExtraction: { configured: false, tool: false, leadVerificationTool: false },
					webLeadVerification: { configured: false, tool: false, bounded: true }
				})
			)
		);

		await expect(gatewayHealth()).resolves.toMatchObject({
			ok: true,
			requiredReady: true,
			webExtractionReady: false,
			providers: {
				browser: false,
				webResearch: false,
				webExtraction: false,
				webLeadVerification: false
			}
		});
	});

	it('uses authoritative Hermes provider readiness when capabilities disagree', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				isolationReadyResponse({}, {
					browser: { configured: false },
					webSearch: { configured: false }
				})
			)
		);

		await expect(gatewayHealth()).resolves.toMatchObject({
			ok: true,
			requiredReady: true,
			providers: {
				browser: false,
				webResearch: false,
				webExtraction: true,
				webLeadVerification: true
			}
		});
	});

	it('does not report an older Hermes service as isolation-ready', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						service: 'newscraft-agent',
						toolset: 'newscraft-agent',
						tools: ['browser_navigate', 'browser_snapshot'],
						runtime: { provider: 'openai', model: 'gpt-5-mini', endpointMode: 'explicit', apiMode: 'responses', orchestration: 'newscraft' },
						capabilities: {
							standard: true,
				boundedLoop: { configured: true, cancellation: true, stepBudget: true, timeBudget: true, costBudget: false },
							browser: true,
							webResearch: true,
							terminal: true,
							files: true,
							codeExecution: true,
							delegation: true,
							skills: true,
							memory: true,
							webExtraction: {
								configured: true,
								backend: 'newscraft-local',
								archiveProvider: 'wayback',
								tool: true,
								leadVerificationTool: true
							},
							webLeadVerification: { configured: true, bounded: true }
						}
					}),
					{ status: 200 }
				)
			)
		);

		 await expect(gatewayHealth()).resolves.toMatchObject({ ok: false, status: 200 });
	 });

	it('accepts extra Hermes tools without a NewsCraft allowlist', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						service: 'newscraft-agent',
						toolset: 'newscraft-agent',
						tools: [
							'web_search',
							'browser_navigate',
							'browser_snapshot',
							'terminal',
							'verify_this_lead',
							'future_hermes_tool'
						],
						runtime: {
							provider: 'openai',
							model: 'gpt-5-mini',
							endpointMode: 'explicit', apiMode: 'responses', orchestration: 'newscraft'
						},
						capabilities: {
							standard: true,
				boundedLoop: { configured: true, cancellation: true, stepBudget: true, timeBudget: true, costBudget: false },
							accountIsolation: {
								tenantHeader: 'x-newscraft-tenant-key',
								contextLocalHome: true,
								stableTaskKey: true,
								ownedRunState: true,
					conversationWorkspace: true,
								isolatedBrowserProfiles: true
							},
							browser: true,
							webResearch: true,
							webExtraction: {
								configured: true,
								backend: 'newscraft-local',
								archiveProvider: 'wayback',
								tool: true,
								leadVerificationTool: true
							},
							webLeadVerification: { configured: true, tool: true, bounded: true },
							terminal: true,
							files: true,
							codeExecution: true,
							delegation: true,
							skills: true,
							memory: true,
							durableRuns: { configured: true, callback: true }
						}
					}),
					{ status: 200 }
				)
			)
		);

		await expect(gatewayHealth()).resolves.toMatchObject({ ok: true, status: 200 });
	});

	it('uses a bounded five-second timeout for cold gateway readiness probes', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const fetchMock = vi.fn().mockResolvedValue(isolationReadyResponse());
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toMatchObject({ ok: true, status: 200 });
		expect(timeout).toHaveBeenCalledWith(5_000);
		expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
		timeout.mockRestore();
	});

	it('fails closed when Hermes configuration is missing', async () => {
		delete process.env.NEWSCRAFT_HERMES_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toMatchObject({ ok: false, status: 0 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('uses the canonical agent configuration with stable migrated tenant identity', async () => {
		const stableTenant = deriveHermesTenantKey('account-a');
		vi.stubEnv('NEWSCRAFT_AGENT_URL', 'https://agent.test/');
		vi.stubEnv('NEWSCRAFT_AGENT_API_TOKEN', 'test-agent-token');
		vi.stubEnv('NEWSCRAFT_AGENT_TENANT_SECRET', 'test-tenant-secret-0123456789012345');
		const fetchMock = vi.fn().mockResolvedValue(isolationReadyResponse());
		vi.stubGlobal('fetch', fetchMock);
		await expect(gatewayHealth()).resolves.toMatchObject({ ok: true, service: 'newscraft-agent' });
		expect(fetchMock).toHaveBeenCalledWith('https://agent.test/ready', expect.objectContaining({
			headers: expect.objectContaining({ authorization: 'Bearer test-agent-token' })
		}));
		expect(deriveHermesTenantKey('account-a')).toBe(stableTenant);
	});

	it('rejects the retired runtime identity and incomplete bounded-loop guarantees', async () => {
		const old = await isolationReadyResponse().json();
		old.service = 'newscraft-hermes-chat';
		old.toolset = 'hermes-acp';
		const fetchMock = vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(old)))
			.mockResolvedValueOnce(isolationReadyResponse({ boundedLoop: { configured: true, cancellation: true } }));
		vi.stubGlobal('fetch', fetchMock);
		await expect(gatewayHealth()).resolves.toMatchObject({ ok: false, requiredReady: false });
		await expect(gatewayHealth()).resolves.toMatchObject({ ok: false, requiredReady: false });
	});

	it('propagates only explicit public custom activity and omits reasoning events', async () => {
		const response = aguiStream(
			{ type: 'CUSTOM', name: 'newscraft.plan', value: { source: 'model', steps: [{ id: 'read', label: 'Read the release', status: 'running' }], reasoning: 'private deliberation' } },
			{ type: 'CUSTOM', name: 'newscraft.decision', value: { id: 'official', summary: 'The release provides the baseline.', thinking: 'private deliberation' } },
			{ type: 'CUSTOM', name: 'model.reasoning', value: { text: 'private deliberation' } },
			{ type: 'REASONING_MESSAGE_CONTENT', delta: 'private deliberation' },
			{ type: 'RUN_FINISHED' }
		);
		const output = await new Response(normalizeHermesSse(response.body!)).text();
		expect(output).toContain('event: agent.plan');
		expect(output).toContain('event: agent.decision');
		expect(output).toContain('The release provides the baseline.');
		expect(output).not.toContain('private deliberation');
		expect(output).not.toContain('thinking');
	});

	it('preserves tool rejection status through the tool end event', async () => {
		const response = aguiStream(
			{ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'terminal' },
			{ type: 'TOOL_CALL_RESULT', toolCallId: 't1', result: { error: 'Command is unavailable.' } },
			{ type: 'TOOL_CALL_END', toolCallId: 't1' }
		);
		const output = await new Response(normalizeHermesSse(response.body!)).text();
		expect(output).toContain('"status":"failed","done":true');
		expect(output).not.toContain('"status":"ok"');
	});

	it('describes network failures as Hermes failures', () => {
		expect(describeGatewayError(new Error('fetch failed'))).toContain('NewsCraft agent is not reachable');
	});
});
