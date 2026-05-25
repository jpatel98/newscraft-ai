import { describe, expect, it } from 'vitest';
import {
	atomAdapter,
	rssAdapter,
	selectSourceAdapter,
	sitemapAdapter,
	type SourceAdapterExtractInput
} from '../src/tools/sources.js';

function extractInput(body: string, contentType: string | null, url = 'https://example.test/feed'): SourceAdapterExtractInput {
	return {
		url,
		body,
		contentType,
		fetchedAt: '2026-05-24T12:00:00.000Z',
		statusCode: 200,
		contentHash: 'hash',
		cache: {
			contentHash: 'hash',
			etag: '"abc"',
			lastModified: 'Sun, 24 May 2026 12:00:00 GMT',
			cacheControl: null,
			expires: null,
			contentLength: null
		}
	};
}

describe('source adapters', () => {
	it('selects adapters by feed and document shape', () => {
		expect(selectSourceAdapter({ url: 'https://example.test/rss', contentType: 'application/rss+xml', body: '' }).kind).toBe(
			'rss'
		);
		expect(selectSourceAdapter({ url: 'https://example.test/atom', contentType: 'application/atom+xml', body: '' }).kind).toBe(
			'atom'
		);
		expect(
			selectSourceAdapter({
				url: 'https://example.test/sitemap.xml',
				contentType: null,
				body: '<urlset><url><loc>https://example.test/story</loc></url></urlset>'
			}).kind
		).toBe('sitemap');
		expect(selectSourceAdapter({ url: 'https://example.test/story', contentType: 'text/html', body: '<article />' }).kind).toBe(
			'html_article'
		);
	});

	it('parses RSS items with provenance metadata', async () => {
		const items = await rssAdapter.discover(
			extractInput(`
				<rss><channel>
					<item>
						<title>Ottawa adds new transit funding</title>
						<link>https://example.test/news/transit</link>
						<description>Funding will support several delayed station repairs.</description>
						<pubDate>Sun, 24 May 2026 10:30:00 GMT</pubDate>
					</item>
				</channel></rss>
			`, 'application/rss+xml')
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			url: 'https://example.test/news/transit',
			title: 'Ottawa adds new transit funding',
			summary: 'Funding will support several delayed station repairs.',
			publishedAt: '2026-05-24T10:30:00.000Z',
			provenance: {
				adapter: 'rss',
				sourceUrl: 'https://example.test/feed',
				contentHash: 'hash',
				etag: '"abc"'
			}
		});
	});

	it('parses Atom entries and sitemap URLs', async () => {
		const atomItems = await atomAdapter.discover(
			extractInput(
				`
				<feed>
					<entry>
						<title>Province publishes budget update</title>
						<link href="/budget-update" rel="alternate" />
						<summary>Officials said the update includes revised revenue projections.</summary>
						<updated>2026-05-24T11:00:00Z</updated>
					</entry>
				</feed>
			`,
				'application/atom+xml',
				'https://example.test/atom'
			)
		);
		const sitemapItems = await sitemapAdapter.discover(
			extractInput(
				`
				<urlset>
					<url>
						<loc>https://example.test/local/story-one</loc>
						<lastmod>2026-05-24</lastmod>
					</url>
				</urlset>
			`,
				'application/xml',
				'https://example.test/sitemap.xml'
			)
		);

		expect(atomItems[0]).toMatchObject({
			url: 'https://example.test/budget-update',
			title: 'Province publishes budget update',
			updatedAt: '2026-05-24T11:00:00.000Z',
			provenance: { adapter: 'atom' }
		});
		expect(sitemapItems[0]).toMatchObject({
			url: 'https://example.test/local/story-one',
			title: 'story-one',
			updatedAt: '2026-05-24T00:00:00.000Z',
			provenance: { adapter: 'sitemap' }
		});
	});
});
