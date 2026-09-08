import { describe, expect, it } from 'vitest';
import {
	ArtifactDetailCache,
	ArtifactDetailCacheError,
	ArtifactRequestGate,
	type ArtifactDetailCacheKey
} from './artifact-detail-cache';
import type { ArtifactDetail } from '$lib/types/artifacts';

const key = (overrides: Partial<ArtifactDetailCacheKey> = {}): ArtifactDetailCacheKey => ({
	accountId: 'account-a',
	conversationId: 'conversation-a',
	artifactId: 'family-a',
	revisionId: 'revision-a',
	...overrides
});

function detail(overrides: Partial<ArtifactDetail> = {}): ArtifactDetail {
	return {
		id: 'family-a',
		revisionId: 'revision-a',
		revision: 1,
		kind: 'markdown',
		title: 'Cached artifact',
		status: 'ready',
		sourceMessageId: 'message-a',
		createdAt: 1,
		updatedAt: 1,
		spec: { kind: 'markdown', title: 'Cached artifact', markdown: 'ready' },
		assets: [],
		...overrides
	};
}

describe('ArtifactDetailCache', () => {
	it('deduplicates concurrent detail requests and caches only the ready result', async () => {
		const cache = new ArtifactDetailCache(2);
		let calls = 0;
		let resolveRequest: ((value: ArtifactDetail) => void) | undefined;
		const fetcher = () => {
			calls += 1;
			return new Promise<ArtifactDetail>((resolve) => (resolveRequest = resolve));
		};
		const first = cache.getOrFetch(key(), fetcher);
		const second = cache.getOrFetch(key(), fetcher);
		expect(calls).toBe(1);
		resolveRequest?.(detail());
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toBe(secondResult);
		expect(cache.size).toBe(1);
		expect(cache.get(key())).toBe(firstResult);
	});

	it('keeps account and conversation scopes separate', async () => {
		const cache = new ArtifactDetailCache();
		const accountB = key({ accountId: 'account-b' });
		const conversationB = key({ conversationId: 'conversation-b' });
		await cache.getOrFetch(key(), async () => detail());
		await cache.getOrFetch(accountB, async () => detail({ id: 'family-a', revisionId: 'revision-a' }));
		await cache.getOrFetch(conversationB, async () => detail());
		let calls = 0;
		await cache.getOrFetch(key({ accountId: 'account-c' }), async () => {
			calls += 1;
			return detail();
		});
		expect(calls).toBe(1);
		expect(cache.get(key({ accountId: 'account-b' }))).not.toBeNull();
		expect(cache.get(key({ conversationId: 'conversation-b' }))).not.toBeNull();
	});

	it('does not cache missing, mismatched, or non-ready responses', async () => {
		const cache = new ArtifactDetailCache();
		let missingCalls = 0;
		const missing = async () => {
			missingCalls += 1;
			return null;
		};
		await expect(cache.getOrFetch(key(), missing)).rejects.toMatchObject({ code: 'not_found' });
		await expect(cache.getOrFetch(key(), missing)).rejects.toMatchObject({ code: 'not_found' });
		expect(missingCalls).toBe(2);

		await expect(cache.getOrFetch(key({ revisionId: 'revision-b' }), async () => detail())).rejects.toMatchObject({ code: 'mismatched_revision' });
		await expect(cache.getOrFetch(key({ revisionId: 'revision-b' }), async () => detail())).rejects.toBeInstanceOf(ArtifactDetailCacheError);
		await cache.getOrFetch(key({ revisionId: 'revision-c' }), async () => detail({ revisionId: 'revision-c', status: 'publishing' }));
		expect(cache.get(key({ revisionId: 'revision-c' }))).toBeNull();
	});

	it('evicts the least recently used ready revision at the bound', async () => {
		const cache = new ArtifactDetailCache(2);
		const first = key({ artifactId: 'family-1', revisionId: 'revision-1' });
		const second = key({ artifactId: 'family-2', revisionId: 'revision-2' });
		const third = key({ artifactId: 'family-3', revisionId: 'revision-3' });
		await cache.getOrFetch(first, async () => detail({ id: first.artifactId, revisionId: first.revisionId }));
		await cache.getOrFetch(second, async () => detail({ id: second.artifactId, revisionId: second.revisionId }));
		expect(cache.get(first)).not.toBeNull();
		await cache.getOrFetch(third, async () => detail({ id: third.artifactId, revisionId: third.revisionId }));
		expect(cache.get(second)).toBeNull();
		expect(cache.get(first)).not.toBeNull();
		expect(cache.get(third)).not.toBeNull();
	});
});

describe('ArtifactRequestGate', () => {
	it('rejects stale completions after a newer click or close', () => {
		const gate = new ArtifactRequestGate();
		const first = gate.begin();
		const second = gate.begin();
		expect(gate.isCurrent(first)).toBe(false);
		expect(gate.isCurrent(second)).toBe(true);
		gate.invalidate();
		expect(gate.isCurrent(second)).toBe(false);
	});
});
