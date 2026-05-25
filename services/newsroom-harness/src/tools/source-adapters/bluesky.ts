import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { adapterFetch, cleanText, dateText, defaultDiff, hostMatches, sourceItem } from './utils.js';

export const blueskyAdapter: SourceAdapter = {
	kind: 'api_bluesky',
	canHandle({ url, contentType, body }) {
		return Boolean(
			hostMatches(url, ['bsky.app', 'bsky.social']) ||
				(contentType?.includes('json') && /app\.bsky\.feed\.post|at:\/\/|did:plc:/i.test((body ?? '').slice(0, 6000)))
		);
	},
	fetch: adapterFetch,
	discover: parseBlueskyPosts,
	extract: parseBlueskyPosts,
	diff: defaultDiff
};

function parseBlueskyPosts(input: SourceAdapterExtractInput): SourceItem[] {
	const parsed = parseJson(input.body);
	const posts = collectPosts(parsed);
	if (!posts.length && parsed?.record) posts.push(parsed);
	return posts.slice(0, 50).flatMap((post: any) => {
		const record = post.record ?? post;
		const text = typeof record.text === 'string' ? record.text : '';
		if (!text) return [];
		const author = post.author?.handle || post.author?.displayName || didFromUri(post.uri) || 'Bluesky post';
		const url = postUrl(post) || input.url;
		const createdAt = dateText(record.createdAt ?? post.indexedAt ?? null);
		return [
			sourceItem('api_bluesky', input, {
				url,
				title: `${author}: ${text.slice(0, 80)}`,
				summary: text,
				contentText: cleanText(`${author}: ${text}`),
				publishedAt: createdAt,
				updatedAt: dateText(post.indexedAt ?? null)
			})
		];
	});
}

function collectPosts(value: any): any[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.flatMap(collectPosts);
	if (Array.isArray(value.posts)) return value.posts;
	if (Array.isArray(value.feed)) return value.feed.map((entry: any) => entry.post ?? entry).filter(Boolean);
	if (value.post) return [value.post];
	if (value.record?.['$type'] === 'app.bsky.feed.post') return [value];
	return [];
}

function postUrl(post: any): string | null {
	const uri = typeof post.uri === 'string' ? post.uri : '';
	const handle = post.author?.handle;
	const rkey = uri.split('/').pop();
	if (!handle || !rkey) return null;
	return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function didFromUri(uri: unknown): string | null {
	return typeof uri === 'string' ? uri.split('/')[2] || null : null;
}

function parseJson(value: string): any {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
