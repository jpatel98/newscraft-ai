import type { ArtifactDetail } from '$lib/types/artifacts';

export interface ArtifactDetailCacheKey {
	accountId: string;
	conversationId: string;
	artifactId: string;
	revisionId: string;
}

export type ArtifactDetailFetcher = () => Promise<ArtifactDetail | null>;

export class ArtifactDetailCacheError extends Error {
	readonly code: 'not_found' | 'mismatched_revision' | 'not_cacheable';

	constructor(code: ArtifactDetailCacheError['code'], message: string) {
		super(message);
		this.name = 'ArtifactDetailCacheError';
		this.code = code;
	}
}

function keyOf(key: ArtifactDetailCacheKey): string {
	return [key.accountId, key.conversationId, key.artifactId, key.revisionId]
		.map((part) => `${part.length}:${part}`)
		.join('|');
}

function isMatchingRevision(detail: ArtifactDetail, key: ArtifactDetailCacheKey): boolean {
	return detail.id === key.artifactId && detail.revisionId === key.revisionId;
}

function freezeObject<T>(value: T, seen = new WeakSet<object>()): T {
	if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
	seen.add(value as object);
	for (const child of Object.values(value as Record<string, unknown>)) freezeObject(child, seen);
	return Object.freeze(value);
}

/**
 * Session-local cache for immutable ready revisions. It deliberately never
 * caches drafts, failures, or missing responses, and its key includes the
 * authenticated account scope so one account cannot reuse another's detail.
 */
export class ArtifactDetailCache {
	private readonly ready = new Map<string, ArtifactDetail>();
	private readonly pending = new Map<string, Promise<ArtifactDetail>>();
	private readonly maxEntries: number;

	constructor(maxEntries = 24) {
		this.maxEntries = Math.max(1, Math.floor(maxEntries));
	}

	get(key: ArtifactDetailCacheKey): ArtifactDetail | null {
		const cacheKey = keyOf(key);
		const detail = this.ready.get(cacheKey);
		if (!detail) return null;
		this.ready.delete(cacheKey);
		this.ready.set(cacheKey, detail);
		return detail;
	}

	async getOrFetch(key: ArtifactDetailCacheKey, fetcher: ArtifactDetailFetcher): Promise<ArtifactDetail> {
		const cacheKey = keyOf(key);
		const cached = this.get(key);
		if (cached) return cached;
		const existing = this.pending.get(cacheKey);
		if (existing) return existing;

		const request = fetcher().then((detail) => {
			if (!detail) throw new ArtifactDetailCacheError('not_found', 'artifact detail was not found');
			if (!isMatchingRevision(detail, key)) {
				throw new ArtifactDetailCacheError('mismatched_revision', 'artifact detail revision did not match the requested revision');
			}
			if (detail.status !== 'ready') return detail;
			this.put(key, detail);
			return detail;
		});
		this.pending.set(cacheKey, request);
		try {
			return await request;
		} finally {
			if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
		}
	}

	private put(key: ArtifactDetailCacheKey, detail: ArtifactDetail): void {
		const cacheKey = keyOf(key);
		this.ready.delete(cacheKey);
		this.ready.set(cacheKey, freezeObject(detail));
		while (this.ready.size > this.maxEntries) this.ready.delete(this.ready.keys().next().value as string);
	}

	clear(): void {
		this.ready.clear();
	}

	get size(): number {
		return this.ready.size;
	}
}

/** Guards async UI work against a newer click, navigation, or closed canvas. */
export class ArtifactRequestGate {
	private generation = 0;

	begin(): number {
		this.generation += 1;
		return this.generation;
	}

	invalidate(): void {
		this.generation += 1;
	}

	isCurrent(token: number): boolean {
		return token === this.generation;
	}
}
