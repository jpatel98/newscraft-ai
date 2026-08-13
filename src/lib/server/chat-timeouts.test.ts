import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatIdleWatchdog, linkChatAbort, withChatTimeout } from './chat-timeouts';

describe('interactive chat safety bounds', () => {
	afterEach(() => vi.useRealTimers());

	it('does not count an active Hermes tool call as stream idle time', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const watchdog = createChatIdleWatchdog(controller, 100);
		watchdog.activity();
		expect(watchdog.hasActiveTools()).toBe(false);
		watchdog.toolStarted('browser-1');
		expect(watchdog.hasActiveTools()).toBe(true);

		await vi.advanceTimersByTimeAsync(500);
		expect(controller.signal.aborted).toBe(false);

		watchdog.toolFinished('browser-1');
		expect(watchdog.hasActiveTools()).toBe(false);
		await vi.advanceTimersByTimeAsync(99);
		expect(controller.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(controller.signal.aborted).toBe(true);
		expect(watchdog.timedOut()).toBe(true);
		watchdog.cleanup();
	});

	it('keeps the idle timer paused until every concurrent Hermes tool finishes', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const watchdog = createChatIdleWatchdog(controller, 100);
		watchdog.activity();
		watchdog.toolStarted('browser-1');
		watchdog.toolStarted('browser-2');
		watchdog.toolFinished('browser-1');

		await vi.advanceTimersByTimeAsync(500);
		expect(controller.signal.aborted).toBe(false);

		watchdog.toolFinished('browser-2');
		await vi.advanceTimersByTimeAsync(100);
		expect(controller.signal.aborted).toBe(true);
		watchdog.cleanup();
	});

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
