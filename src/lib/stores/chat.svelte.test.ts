import { describe, expect, it, vi } from 'vitest';

import { ChatSession } from './chat.svelte';

describe('ChatSession cancellation', () => {
	it('keeps a durable subscription open while the server accepts the stop', () => {
		const session = new ChatSession();
		const cancelServerRun = vi.fn(() => false);
		const controller = session.startStream('conversation-1');
		session.setCancelHandler(cancelServerRun);

		session.cancel();

		expect(cancelServerRun).toHaveBeenCalledOnce();
		expect(controller.signal.aborted).toBe(false);
		expect(session.abortIntent).toBe('stop');
	});

	it('still aborts a non-durable stream with no server cancel handler', () => {
		const session = new ChatSession();
		const controller = session.startStream('conversation-2');

		session.cancel();

		expect(controller.signal.aborted).toBe(true);
	});
});
