import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import {
	deriveSessionId,
	gatewayHealth,
	streamChatCompletion,
	type HermesMessage
} from './transport';

function expectedSessionId(system: string, firstUser: string): string {
	return createHash('sha256').update(system).update('\0').update(firstUser).digest('hex').slice(0, 32);
}

describe('Hermes transport', () => {
	const originalGatewayUrl = process.env.HERMES_GATEWAY_URL;
	const originalApiKey = process.env.HERMES_API_KEY;

	beforeEach(() => {
		process.env.HERMES_GATEWAY_URL = 'https://gateway.test/';
		process.env.HERMES_API_KEY = 'test-key';
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalGatewayUrl === undefined) delete process.env.HERMES_GATEWAY_URL;
		else process.env.HERMES_GATEWAY_URL = originalGatewayUrl;
		if (originalApiKey === undefined) delete process.env.HERMES_API_KEY;
		else process.env.HERMES_API_KEY = originalApiKey;
	});

	it('derives deterministic session ids from the system prompt and first user text only', () => {
		const messages: HermesMessage[] = [
			{
				role: 'system',
				content: [
					{ type: 'text', text: 'Follow Hermes policy.' },
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
			'Follow Hermes policy.\nPrefer concise answers.',
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
		const messages: HermesMessage[] = [
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
			'x-hermes-session-id': expectedSessionId('system', 'hello')
		});
		expect(JSON.parse(firstInit.body as string)).toMatchObject({
			model: 'hermes-agent',
			stream: true,
			messages
		});
		expect(secondInit.headers['x-hermes-session-id']).toBe('manual-session');
	});

	it('reports gateway health from non-OK responses', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('maintenance', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(gatewayHealth()).resolves.toEqual({
			ok: false,
			status: 503,
			body: 'maintenance'
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
			body: 'Error: network down'
		});
	});
});
