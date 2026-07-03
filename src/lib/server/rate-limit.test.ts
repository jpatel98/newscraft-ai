import { describe, expect, it, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimitsForTests } from './rate-limit';

beforeEach(() => {
	resetRateLimitsForTests();
});

describe('rate limits', () => {
	it('allows requests within a window and blocks after the limit', () => {
		expect(checkRateLimit('chat:user:ip', { limit: 2, windowMs: 1000, now: 100 }).allowed).toBe(true);
		expect(checkRateLimit('chat:user:ip', { limit: 2, windowMs: 1000, now: 200 }).allowed).toBe(true);

		const blocked = checkRateLimit('chat:user:ip', { limit: 2, windowMs: 1000, now: 300 });

		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterMs).toBe(800);
	});

	it('resets after the window expires', () => {
		checkRateLimit('login:ip', { limit: 1, windowMs: 1000, now: 100 });

		expect(checkRateLimit('login:ip', { limit: 1, windowMs: 1000, now: 1200 }).allowed).toBe(true);
	});
});
