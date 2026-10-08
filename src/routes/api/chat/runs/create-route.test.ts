import { beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.hoisted(() => ({ POST: vi.fn() }));
vi.mock('../stream/+server', () => streamMock);

import { POST } from './+server';

describe('durable chat create route', () => {
	beforeEach(() => vi.resetAllMocks());

	it('forwards the same request to durable chat preparation without adding a mode header', async () => {
		const durableResponse = new Response('ok');
		streamMock.POST.mockResolvedValue(durableResponse);
		const request = new Request('http://localhost/api/chat/runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ conversation_id: 'conversation-1', content: 'hello', idempotency_key: 'browser-turn-1' })
		});
		const event = { request, locals: {}, getClientAddress: () => '127.0.0.1' };

		const response = await POST(event as any);

		expect(response).toBe(durableResponse);
		expect(streamMock.POST).toHaveBeenCalledWith(event);
		const forwarded = streamMock.POST.mock.calls[0][0].request as Request;
		expect(forwarded).toBe(request);
		expect(forwarded.headers.get('x-newscraft-durable-run')).toBeNull();
		expect(await forwarded.json()).toEqual({ conversation_id: 'conversation-1', content: 'hello', idempotency_key: 'browser-turn-1' });
	});

	it('preserves authentication errors from the shared chat handler', async () => {
		const unauthorized = { status: 401, body: { message: 'unauthorized' } };
		streamMock.POST.mockRejectedValue(unauthorized);
		const event = { request: new Request('http://localhost/api/chat/runs', { method: 'POST' }), locals: {} };
		await expect(POST(event as any)).rejects.toBe(unauthorized);
		expect(streamMock.POST).toHaveBeenCalledWith(event);
	});
});
