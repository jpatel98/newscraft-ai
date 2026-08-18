import { describe, expect, it, vi } from 'vitest';

const streamMock = vi.hoisted(() => ({ POST: vi.fn() }));
vi.mock('../stream/+server', () => streamMock);

import { POST } from './+server';

describe('durable chat create route', () => {
	it('marks the NewsCraft request as durable before chat preparation runs', async () => {
		streamMock.POST.mockResolvedValue(new Response('ok'));
		const request = new Request('http://localhost/api/chat/runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ conversation_id: 'conversation-1', content: 'hello' })
		});
		const event = { request, locals: {}, getClientAddress: () => '127.0.0.1' };

		await POST(event as any);

		expect(streamMock.POST).toHaveBeenCalledWith(
			expect.objectContaining({
				request: expect.objectContaining({ headers: expect.any(Headers) })
			})
		);
		const forwarded = streamMock.POST.mock.calls[0][0].request as Request;
		expect(forwarded.headers.get('x-newscraft-durable-run')).toBe('1');
		expect(await forwarded.json()).toMatchObject({ conversation_id: 'conversation-1' });
	});
});
