import { describe, expect, it } from 'vitest';
import { linkChatAbort, withChatTimeout } from './chat-timeouts';

describe('interactive chat safety bounds', () => {
	it('rejects a stalled persistence or synthesis phase with a typed timeout', async () => {
		await expect(withChatTimeout(new Promise<never>(() => {}), 5, 'test phase')).rejects.toMatchObject({
			name: 'TimeoutError',
			message: 'test phase timed out'
		});
	});

	it('aborts the upstream phase when its request-owned maximum elapses', async () => {
		const request = new AbortController();
		const linked = linkChatAbort(request.signal, 5);
		await new Promise((resolve) => setTimeout(resolve, 15));

		expect(linked.controller.signal.aborted).toBe(true);
		expect(linked.timedOut()).toBe(true);
		linked.cleanup();
	});
});
