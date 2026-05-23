import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
	describeGatewayError,
	deriveSessionId,
	gatewayHealth,
	streamChatCompletion,
	type AgentMessage
} from './transport';

function expectedSessionId(system: string, firstUser: string): string {
	return createHash('sha256').update(system).update('\0').update(firstUser).digest('hex').slice(0, 32);
}

describe('Agent transport', () => {
	const originalGatewayUrl = process.env.AGENT_GATEWAY_URL;
	const originalAgentApiKey = process.env.AGENT_GATEWAY_API_KEY;
	const originalHarnessApiKey = process.env.NEWSROOM_HARNESS_API_KEY;

	beforeEach(() => {
		delete process.env.AGENT_GATEWAY_URL;
		delete process.env.AGENT_GATEWAY_API_KEY;
		delete process.env.NEWSROOM_HARNESS_API_KEY;
		process.env.AGENT_GATEWAY_URL = 'https://gateway.test/';
		process.env.AGENT_GATEWAY_API_KEY = 'test-key';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalGatewayUrl === undefined) delete process.env.AGENT_GATEWAY_URL;
		else process.env.AGENT_GATEWAY_URL = originalGatewayUrl;
		if (originalAgentApiKey === undefined) delete process.env.AGENT_GATEWAY_API_KEY;
		else process.env.AGENT_GATEWAY_API_KEY = originalAgentApiKey;
		if (originalHarnessApiKey === undefined) delete process.env.NEWSROOM_HARNESS_API_KEY;
		else process.env.NEWSROOM_HARNESS_API_KEY = originalHarnessApiKey;
	});

	it('derives deterministic session ids from the system prompt and first user text only', () => {
		const messages: AgentMessage[] = [
			{
				role: 'system',
				content: [
					{ type: 'text', text: 'Follow Agent policy.' },
					{ type: 'image_url', image_url: { url: 'https://example.com/system.png' } },
					{ type: 'text', text: 'Prefer concise answers.' }
				]
			},
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: 'https://example.com/input-a.png' } },
					{ type: 'text', text: 'Summarize this.' },
					{ type: 'text', text: 'Keep the source names.' }
				]
			},
			{ role: 'assistant', content: 'Older answer' },
			{ role: 'user', content: 'This later turn must not affect the session.' }
		];

		const expected = expectedSessionId(
			'Follow Agent policy.\nPrefer concise answers.',
			'Summarize this.\nKeep the source names.'
		);

		expect(deriveSessionId(messages)).toBe(expected);
		expect(deriveSessionId(messages)).toBe(deriveSessionId([...messages]));
		expect(
			deriveSessionId([
				...messages.slice(0, 1),
				{
					role: 'user',
					content: [
						{ type: 'image_url', image_url: { url: 'https://example.com/input-b.png' } },
						{ type: 'text', text: 'Summarize this.' },
						{ type: 'text', text: 'Keep the source names.' }
					]
				},
				{ role: 'user', content: 'Different later turn.' }
			])
		).toBe(expected);
	});

	it('sends a derived session id unless the caller provides one', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const messages: AgentMessage[] = [
			{ role: 'system', content: 'system' },
			{ role: 'user', content: 'hello' }
		];

		await streamChatCompletion({ messages });
		await streamChatCompletion({ messages }, { sessionId: 'manual-session' });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit & {
			headers: Record<string, string>;
		};
		const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit & {
			headers: Record<string, string>;
		};
		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.test/v1/chat/completions');
		expect(firstInit.headers).toMatchObject({
			accept: 'text/event-stream',
			authorization: 'Bearer test-key',
			'content-type': 'application/json',
			'x-agent-session-id': expectedSessionId('system', 'hello')
		});
		expect(JSON.parse(firstInit.body as string)).toMatchObject({
			model: 'newsroom-agent',
			stream: true,
			messages
		});
		expect(secondInit.headers['x-agent-session-id']).toBe('manual-session');
	});

	it('passes reasoning effort through to Agent chat completions', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const messages: AgentMessage[] = [{ role: 'user', content: 'think harder' }];

		await streamChatCompletion({ messages, reasoning_effort: 'high' });

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toMatchObject({
			model: 'newsroom-agent',
			stream: true,
			messages,
			reasoning_effort: 'high'
		});
	});

	it('prefers the NewsCraft agent gateway URL and API key when configured', async () => {
		process.env.AGENT_GATEWAY_URL = 'https://harness.test/';
		process.env.AGENT_GATEWAY_API_KEY = 'harness-key';
		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await streamChatCompletion({ messages: [{ role: 'user', content: 'hello' }] });

		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://harness.test/v1/chat/completions');
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
		expect(init.headers.authorization).toBe('Bearer harness-key');
	});

	it('allows unauthenticated requests when only AGENT_GATEWAY_URL is configured', async () => {
		process.env.AGENT_GATEWAY_URL = 'https://harness.test';
		delete process.env.AGENT_GATEWAY_API_KEY;
		const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await streamChatCompletion({ messages: [{ role: 'user', content: 'hello' }] });

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
		expect(init.headers.authorization).toBeUndefined();
	});

	it('reports gateway health from non-OK responses', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('maintenance', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toEqual({
			ok: false,
			status: 503,
			body: 'maintenance',
			json: null,
			service: null,
			url: 'https://gateway.test'
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://gateway.test/health',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it('reports failed gateway health fetches without throwing', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

		await expect(gatewayHealth()).resolves.toEqual({
			ok: false,
			status: 0,
			body: 'network down',
			json: null,
			service: null,
			url: 'https://gateway.test'
		});
	});

	it('treats health JSON ok:false as unavailable even with HTTP 200', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ ok: false, service: 'newsroom-harness' }), { status: 200 })
			);
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toMatchObject({
			ok: false,
			status: 200,
			json: { ok: false, service: 'newsroom-harness' },
			service: 'newsroom-harness',
			url: 'https://gateway.test'
		});
	});

	it('explains raw fetch failures as an unreachable agent gateway', () => {
		expect(describeGatewayError(new TypeError('fetch failed'))).toBe(
			'Agent gateway is not reachable at https://gateway.test. Start the gateway or update AGENT_GATEWAY_URL.'
		);
	});

	it('uses AGENT_GATEWAY_URL in gateway error hints when configured', () => {
		process.env.AGENT_GATEWAY_URL = 'https://harness.test';
		expect(describeGatewayError(new TypeError('fetch failed'))).toBe(
			'Agent gateway is not reachable at https://harness.test. Start the gateway or update AGENT_GATEWAY_URL.'
		);
	});
});
