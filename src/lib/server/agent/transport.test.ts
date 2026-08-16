import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
	agentFetch,
	completion,
	describeGatewayError,
	deriveHermesTenantKey,
	deriveSessionId,
	gatewayHealth,
	normalizeHermesSse,
	streamChatCompletion,
	type AgentMessage
} from './transport';

function aguiStream(...events: Array<Record<string, unknown>>): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
		status: 200,
		headers: { 'content-type': 'text/event-stream' }
	});
}

function isolationReadyResponse(): Response {
	return new Response(
		JSON.stringify({
			ok: true,
			service: 'newscraft-hermes-chat',
			toolset: 'hermes-acp',
			tools: ['browser_navigate', 'browser_snapshot', 'terminal', 'web_extract', 'verify_this_lead'],
			runtime: { provider: 'openai', model: 'gpt-5-mini', endpointMode: 'explicit' },
			capabilities: {
				standard: true,
				accountIsolation: {
					tenantHeader: 'x-newscraft-tenant-key',
					contextLocalHome: true,
					stableTaskKey: true,
					persistentDockerWorkspace: true,
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
				memory: true
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
		process.env.NEWSCRAFT_HERMES_URL = 'https://hermes.test/';
		process.env.NEWSCRAFT_HERMES_API_TOKEN = 'test-hermes-token';
		process.env.NEWSCRAFT_HERMES_TENANT_SECRET = 'test-tenant-secret-0123456789012345';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalUrl === undefined) delete process.env.NEWSCRAFT_HERMES_URL;
		else process.env.NEWSCRAFT_HERMES_URL = originalUrl;
		if (originalToken === undefined) delete process.env.NEWSCRAFT_HERMES_API_TOKEN;
		else process.env.NEWSCRAFT_HERMES_API_TOKEN = originalToken;
		if (originalTenantSecret === undefined) delete process.env.NEWSCRAFT_HERMES_TENANT_SECRET;
		else process.env.NEWSCRAFT_HERMES_TENANT_SECRET = originalTenantSecret;
	});

	it('derives a stable private session id from the first turn and server scope', () => {
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
	});

	it('derives an opaque server tenant key and never sends the raw account id', async () => {
		const fetchMock = vi.fn().mockImplementation((input: unknown) =>
			String(input).endsWith('/ready') ? isolationReadyResponse() : aguiStream({ type: 'RUN_FINISHED' })
		);
		vi.stubGlobal('fetch', fetchMock);

		await streamChatCompletion(
			{ messages: [{ role: 'user', content: 'Keep this account-local.' }] },
			{ accountId: 'account-a', sessionId: 'thread-a' }
		);

		const init = fetchMock.mock.calls[1]?.[1] as RequestInit & { headers: Record<string, string> };
		const tenantKey = init.headers['x-newscraft-tenant-key'];
		expect(tenantKey).toBe(deriveHermesTenantKey('account-a'));
		expect(tenantKey).toMatch(/^[A-Za-z0-9_-]{32,}$/);
		expect(tenantKey).not.toContain('account-a');
		expect(JSON.stringify(init)).not.toContain('account-a');
		expect(tenantKey).not.toBe(deriveHermesTenantKey('account-b'));
	});

	it('derives an account-scoped session id when a caller does not provide one', async () => {
		const fetchMock = vi.fn().mockImplementation((input: unknown) =>
			String(input).endsWith('/ready') ? isolationReadyResponse() : aguiStream({ type: 'RUN_FINISHED' })
		);
		vi.stubGlobal('fetch', fetchMock);
		const body = { messages: [{ role: 'user' as const, content: 'Keep this session local.' }] };

		await streamChatCompletion(body, { accountId: 'account-a' });
		await streamChatCompletion(body, { accountId: 'account-b' });

		const firstHeaders = fetchMock.mock.calls[1]?.[1] as RequestInit & { headers: Record<string, string> };
		const secondHeaders = fetchMock.mock.calls[3]?.[1] as RequestInit & { headers: Record<string, string> };
		expect(firstHeaders.headers['x-hermes-session-id']).not.toBe(secondHeaders.headers['x-hermes-session-id']);
	});

	it('fails closed when a chat run has no authenticated account scope', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(streamChatCompletion({ messages: [{ role: 'user', content: 'No tenant.' }] })).rejects.toThrow(
			'authenticated account scope'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends one authenticated AG-UI request with no browser-provided tools', async () => {
		const fetchMock = vi.fn().mockImplementation((input: unknown) =>
			String(input).endsWith('/ready')
				? isolationReadyResponse()
				: aguiStream(
					{ type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
					{ type: 'TEXT_MESSAGE_START', messageId: 'answer-1', role: 'assistant' },
					{ type: 'TEXT_MESSAGE_CONTENT', delta: 'Hermes reply.' },
					{ type: 'TEXT_MESSAGE_END', messageId: 'answer-1' },
					{ type: 'RUN_FINISHED' }
				)
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await streamChatCompletion(
			{
				messages: [
					{ role: 'system', content: 'Newsroom system' },
					{ role: 'user', content: 'Research this.' }
				],
				stream: true,
				newsroom_context: { timezone: 'America/Toronto' }
			},
			{ accountId: 'account-a', sessionId: 'thread', traceId: 'trace_12345678' }
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[0]).toBe('https://hermes.test/');
		const init = fetchMock.mock.calls[1]?.[1] as RequestInit & { headers: Record<string, string> };
		expect(init.headers).toMatchObject({
			authorization: 'Bearer test-hermes-token',
			'x-hermes-session-token': 'test-hermes-token',
			'x-hermes-session-id': 'thread',
			'x-trace-id': 'trace_12345678'
		});
		const body = JSON.parse(init.body as string) as {
			state: { newscraftSources: unknown[] };
			forwardedProps: {
				source: string;
				operation: string;
				webExtractConfigured: boolean;
				retrievalVerificationTool: string;
				stateWriterTools: Array<Record<string, unknown>>;
			};
			[key: string]: unknown;
		};
		expect(body).toMatchObject({
			threadId: 'thread',
			runId: 'trace_12345678',
			state: { newscraftSources: [] },
			tools: [],
			forwardedProps: {
				source: 'newscraft',
				operation: 'chat',
				webExtractConfigured: false,
				retrievalVerificationTool: 'verify_this_lead',
				retrievalBackend: 'newscraft-local',
				retrievalMaxUrls: 5,
				archiveFallback: 'wayback'
			}
		});
		expect(body.forwardedProps.stateWriterTools).toEqual([
			expect.objectContaining({
				name: 'record_newscraft_source',
				stateKey: 'newscraftSources',
				arg: 'source',
				mode: 'append'
			})
		]);
		const text = await response.text();
		expect(text).toContain('event: agent.answer.replace');
		expect(text).toContain('Hermes reply.');
	});

	it('checks retrieval readiness before a research run and makes no fallback request', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					service: 'newscraft-hermes-chat',
					toolset: 'hermes-acp',
					tools: ['web_search', 'web_extract', 'browser_navigate', 'browser_snapshot'],
					runtime: { provider: 'custom', model: 'old-model', endpointMode: 'explicit' },
					capabilities: {
						standard: true,
						browser: true,
						webResearch: true,
						terminal: true,
						files: true,
						codeExecution: true,
						delegation: true,
						skills: true,
						memory: true
					}
				}),
				{ status: 200 }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			streamChatCompletion(
				{ messages: [{ role: 'user', content: 'Research the latest update.' }] },
				{ accountId: 'account-a', requireWebExtraction: true }
			)
		).rejects.toThrow('web extraction is not configured');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://hermes.test/ready');
	});

	it('sends a research run only after retrieval readiness passes', async () => {
		const ready = {
			ok: true,
			service: 'newscraft-hermes-chat',
			toolset: 'hermes-acp',
			tools: ['web_search', 'web_extract', 'verify_this_lead', 'browser_navigate', 'browser_snapshot'],
			runtime: { provider: 'custom', model: 'new-model', endpointMode: 'explicit' },
			capabilities: {
				standard: true,
				accountIsolation: {
					tenantHeader: 'x-newscraft-tenant-key',
					contextLocalHome: true,
					stableTaskKey: true,
					persistentDockerWorkspace: true,
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
				memory: true
			}
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify(ready), { status: 200 }))
			.mockResolvedValueOnce(aguiStream({ type: 'RUN_FINISHED' }));
		vi.stubGlobal('fetch', fetchMock);

		await streamChatCompletion(
			{ messages: [{ role: 'user', content: 'Research the latest update.' }] },
			{ accountId: 'account-a', requireWebExtraction: true }
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const requestBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
			forwardedProps: { webExtractConfigured: boolean };
		};
		expect(requestBody.forwardedProps.webExtractConfigured).toBe(true);
	});

	it('seeds attached document pages as inspectable citations', async () => {
		const fetchMock = vi.fn().mockImplementation((input: unknown) =>
			String(input).endsWith('/ready') ? isolationReadyResponse() : aguiStream({ type: 'RUN_FINISHED' })
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await streamChatCompletion(
			{
				messages: [{ role: 'user', content: 'Use the attached PDF.' }],
				documents: [
					{
						id: 'doc-1',
						filename: 'brief.pdf',
						downloadUrl: '/api/documents/doc-1/download',
						pageCount: 2,
						pages: [{ pageNumber: 2, text: 'Council approved the motion.' }]
					}
				]
			},
		{ accountId: 'account-a' }
		);

			const requestBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
			context: Array<{ description: string; value: string }>;
		};
		const documentContext = requestBody.context.find((entry) => entry.description.includes('document'));
		expect(documentContext?.value).toContain('"citationNumber":1');
		const text = await response.text();
		expect(text).toContain('event: agent.citations');
		expect(text).toContain('"sourceType":"user_document"');
		expect(text).toContain('"documentPage":2');
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
		expect(text).toContain('Hermes read this page with its browser.');
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

	it('does not make a second request when Hermes rejects the run', async () => {
		const fetchMock = vi.fn().mockImplementation((input: unknown) =>
			String(input).endsWith('/ready') ? isolationReadyResponse() : new Response('rejected', { status: 404 })
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await streamChatCompletion(
			{ messages: [{ role: 'user', content: 'hello' }] },
			{ accountId: 'account-a' }
		);

		expect(response.status).toBe(404);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does not expose the legacy agent HTTP proxy', async () => {
		await expect(agentFetch('/api/jobs')).rejects.toThrow('Legacy agent-job transport is disabled');
	});

	it('uses the same Hermes run path for short completions', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((input: unknown) =>
				String(input).endsWith('/ready')
					? isolationReadyResponse()
					: aguiStream(
						{ type: 'TEXT_MESSAGE_START', messageId: 'answer-1', role: 'assistant' },
						{ type: 'TEXT_MESSAGE_CONTENT', delta: 'A' },
					{ type: 'TEXT_MESSAGE_CONTENT', delta: ' ' },
					{ type: 'TEXT_MESSAGE_CONTENT', delta: 'concise' },
					{ type: 'TEXT_MESSAGE_CONTENT', delta: ' ' },
						{ type: 'TEXT_MESSAGE_CONTENT', delta: 'title' },
						{ type: 'TEXT_MESSAGE_END', messageId: 'answer-1' },
						{ type: 'RUN_FINISHED' }
					)
			)
		);

		await expect(
			completion(
				{ messages: [{ role: 'user', content: 'Title this.' }] },
				{ accountId: 'account-a' }
			)
		).resolves.toMatchObject({
			choices: [{ message: { content: 'A concise title' } }]
		});
		const fetchMock = vi.mocked(fetch);
		const body = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string) as {
			forwardedProps: { stateWriterTools: unknown[] };
		};
		expect(body.forwardedProps.stateWriterTools).toEqual([]);
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

	it('reports ready for the standard Hermes capability set', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					service: 'newscraft-hermes-chat',
					toolset: 'hermes-acp',
						tools: ['web_search', 'verify_this_lead', 'browser_navigate', 'browser_snapshot', 'terminal'],
					runtime: {
						provider: 'openai',
						model: 'gpt-5-mini',
						endpointMode: 'explicit'
					},
						capabilities: {
							standard: true,
							accountIsolation: {
								tenantHeader: 'x-newscraft-tenant-key',
								contextLocalHome: true,
								stableTaskKey: true,
								persistentDockerWorkspace: true,
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
						memory: true
					}
				}),
				{ status: 200 }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toMatchObject({
			ok: true,
			status: 200,
			service: 'newscraft-hermes-chat',
			url: 'https://hermes.test'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://hermes.test/ready',
			expect.objectContaining({
				headers: expect.objectContaining({ 'x-hermes-session-token': 'test-hermes-token' })
			})
		);
	});

	 it('does not report an older Hermes service as isolation-ready', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						service: 'newscraft-hermes-chat',
						toolset: 'hermes-acp',
						tools: ['browser_navigate', 'browser_snapshot'],
						runtime: { provider: 'openai', model: 'gpt-5-mini', endpointMode: 'explicit' },
						capabilities: {
							standard: true,
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

	it('does not send a chat run to a Hermes service without isolation', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					service: 'newscraft-hermes-chat',
					toolset: 'hermes-acp',
					tools: ['browser_navigate', 'browser_snapshot'],
					runtime: { provider: 'openai', model: 'gpt-5-mini', endpointMode: 'explicit' },
					capabilities: {
						standard: true,
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
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			streamChatCompletion(
				{ messages: [{ role: 'user', content: 'Do not send this to an old service.' }] },
				{ accountId: 'account-a' }
			)
		).rejects.toThrow('account isolation');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/ready');
	});

	it('accepts extra Hermes tools without a NewsCraft allowlist', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						ok: true,
						service: 'newscraft-hermes-chat',
						toolset: 'hermes-acp',
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
							endpointMode: 'explicit'
						},
						capabilities: {
							standard: true,
							accountIsolation: {
								tenantHeader: 'x-newscraft-tenant-key',
								contextLocalHome: true,
								stableTaskKey: true,
								persistentDockerWorkspace: true,
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
							memory: true
						}
					}),
					{ status: 200 }
				)
			)
		);

		await expect(gatewayHealth()).resolves.toMatchObject({ ok: true, status: 200 });
	});

	it('fails closed when Hermes configuration is missing', async () => {
		delete process.env.NEWSCRAFT_HERMES_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toMatchObject({ ok: false, status: 0 });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('describes network failures as Hermes failures', () => {
		expect(describeGatewayError(new Error('fetch failed'))).toContain('Hermes is not reachable');
	});
});
