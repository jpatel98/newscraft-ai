export interface RateLimitResult {
	allowed: boolean;
	retryAfterMs: number;
	remaining: number;
}

interface Bucket {
	resetAt: number;
	count: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
	key: string,
	options: { limit: number; windowMs: number; now?: number }
): RateLimitResult {
	const now = options.now ?? Date.now();
	const existing = buckets.get(key);
	const bucket = existing && existing.resetAt > now ? existing : { resetAt: now + options.windowMs, count: 0 };
	bucket.count += 1;
	buckets.set(key, bucket);

	if (bucket.count > options.limit) {
		return {
			allowed: false,
			retryAfterMs: Math.max(0, bucket.resetAt - now),
			remaining: 0
		};
	}

	return {
		allowed: true,
		retryAfterMs: 0,
		remaining: Math.max(0, options.limit - bucket.count)
	};
}

export function resetRateLimitsForTests(): void {
	buckets.clear();
}
