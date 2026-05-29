import { describe, expect, it } from 'vitest';
import {
	atomAdapter,
	blueskyAdapter,
	htmlArticleAdapter,
	pdfAdapter,
	prWireAdapter,
	rssAdapter,
	selectSourceAdapter,
	sitemapAdapter,
	webSearchAdapter,
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
		expect(
			selectSourceAdapter({
				url: 'https://search.example.test/search?q=ottawa',
				contentType: 'application/json',
				body: '{"results":[]}'
			}).kind
		).toBe('web_search');
		expect(
			selectSourceAdapter({
				url: 'https://www.prnewswire.com/news-releases/example.html',
				contentType: 'text/html',
				body: '<html></html>'
			}).kind
		).toBe('pr_wire');
		expect(selectSourceAdapter({ url: 'https://example.test/report.pdf', contentType: null, body: '%PDF-1.7' }).kind).toBe(
			'pdf'
		);
		expect(
			selectSourceAdapter({
				url: 'https://bsky.social/xrpc/app.bsky.feed.getPosts',
				contentType: 'application/json',
				body: '{"posts":[]}'
			}).kind
		).toBe('api_bluesky');
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

	it('normalizes web search results', async () => {
		const items = await webSearchAdapter.extract(
			extractInput(
				JSON.stringify({
					results: [
						{
							title: 'Ottawa council approves transit funding',
							url: 'https://example.test/news/transit',
							snippet: 'Council approved the funding after a public debate.'
						}
					]
				}),
				'application/json',
				'https://search.example.test/search?q=ottawa%20transit'
			)
		);

		expect(items[0]).toMatchObject({
			url: 'https://example.test/news/transit',
			title: 'Ottawa council approves transit funding',
			summary: 'Council approved the funding after a public debate.',
			provenance: { adapter: 'web_search' }
		});
	});

	it('extracts PR wire-style releases', async () => {
		const items = await prWireAdapter.extract(
			extractInput(
				`
				<html>
					<head>
						<title>Example Corp announces newsroom partnership</title>
						<meta property="article:published_time" content="2026-05-24T09:00:00Z">
					</head>
					<body>
						<article>
							<p>TORONTO, May 24, 2026 -- Example Corp announced a newsroom partnership that expands local reporting capacity.</p>
							<p>The company said the program will start this summer with three pilot newsrooms.</p>
						</article>
					</body>
				</html>
			`,
				'text/html',
				'https://www.prnewswire.com/news-releases/example.html'
			)
		);

		expect(items[0]).toMatchObject({
			title: 'Example Corp announces newsroom partnership',
			publishedAt: '2026-05-24T09:00:00.000Z',
			provenance: { adapter: 'pr_wire' }
		});
		expect(items[0].contentText).toContain('Example Corp announced a newsroom partnership');
	});

	it('extracts JSON-LD NewsArticle metadata and body before readability fallback', async () => {
		const body = [
			'Council approved a late-night transit shuttle network while crews repair the downtown rail tunnel this summer.',
			'The plan adds buses every fifteen minutes on two overnight routes that normally stop running shortly after midnight.',
			'Agency staff said water damage has accelerated corrosion around electrical cabinets and signal equipment.',
			'The transportation department expects the first twelve weeks to cost about two million dollars.'
		].join(' ');
		const items = await htmlArticleAdapter.extract(
			extractInput(
				`
				<html>
					<head>
						<script type="application/ld+json">
							{
								"@context": "https://schema.org",
								"@type": "NewsArticle",
								"headline": "Transit shuttles approved during tunnel repairs",
								"description": "Council approved an overnight shuttle plan for the summer repair period.",
								"articleBody": ${JSON.stringify(body)},
								"datePublished": "2026-05-24T09:30:00-04:00",
								"dateModified": "2026-05-24T10:15:00-04:00",
								"author": { "@type": "Person", "name": "City Desk" },
								"image": "https://example.test/images/transit.jpg",
								"keywords": "transit, council, repairs"
							}
						</script>
					</head>
					<body><nav>Subscribe Search</nav><article><p>Short teaser only.</p></article></body>
				</html>
			`,
				'text/html',
				'https://example.test/news/transit-shuttles'
			)
		);

		expect(items[0]).toMatchObject({
			title: 'Transit shuttles approved during tunnel repairs',
			summary: 'Council approved an overnight shuttle plan for the summer repair period.',
			publishedAt: '2026-05-24T13:30:00.000Z',
			updatedAt: '2026-05-24T14:15:00.000Z',
			metadata: {
				authors: ['City Desk'],
				image: 'https://example.test/images/transit.jpg',
				keywords: ['transit', 'council', 'repairs'],
				metadataSources: ['json_ld'],
				structuredType: 'NewsArticle'
			},
			provenance: {
				adapter: 'html_article',
				extractionMethod: 'json_ld_article_body',
				metadataSources: ['json_ld'],
				structuredType: 'NewsArticle'
			}
		});
		expect(items[0].contentText).toContain('electrical cabinets and signal equipment');
		expect(items[0].contentText).not.toContain('Short teaser only');
	});

	it('combines schema.org, OpenGraph, and Twitter metadata with readable article text', async () => {
		const items = await htmlArticleAdapter.extract(
			extractInput(
				`
				<html>
					<head>
						<meta property="og:title" content="Clinic expansion clears council vote">
						<meta property="og:description" content="Council approved zoning for a larger community clinic.">
						<meta name="twitter:description" content="The clinic project now moves to detailed design.">
						<meta property="article:published_time" content="2026-05-25T08:00:00Z">
					</head>
					<body itemscope itemtype="https://schema.org/NewsArticle">
						<header>Home News Canada Search Subscribe</header>
						<div class="story-content">
							<meta itemprop="dateModified" content="2026-05-25T12:00:00Z">
							<p>Councillors approved zoning changes for a larger community clinic after staff said the current site had run out of exam rooms.</p>
							<p>The health agency said the expansion will add urgent-care capacity and move some specialist appointments closer to transit.</p>
							<div class="share-tools">Share this story Facebook X Reddit</div>
							<p>Construction planning will begin this fall, with a public update expected before the capital budget is finalized.</p>
						</div>
						<footer>Privacy Policy Terms</footer>
					</body>
				</html>
			`,
				'text/html',
				'https://example.test/news/clinic-expansion'
			)
		);

		expect(items[0]).toMatchObject({
			title: 'Clinic expansion clears council vote',
			summary: 'Council approved zoning for a larger community clinic.',
			publishedAt: '2026-05-25T08:00:00.000Z',
			updatedAt: '2026-05-25T12:00:00.000Z',
			metadata: {
				description: 'Council approved zoning for a larger community clinic.',
				structuredType: 'NewsArticle',
				metadataSources: expect.arrayContaining(['schema_org', 'opengraph', 'twitter'])
			},
			provenance: {
				extractionMethod: 'readability',
				metadataSources: expect.arrayContaining(['schema_org', 'opengraph', 'twitter']),
				structuredType: 'NewsArticle'
			}
		});
		expect(items[0].contentText).toContain('urgent-care capacity');
		expect(items[0].contentText).not.toMatch(/Home News Canada|Share this story|Privacy Policy/);
	});

	it('does not let site-level JSON-LD override article OpenGraph metadata', async () => {
		const items = await htmlArticleAdapter.extract(
			extractInput(
				`
				<html>
					<head>
						<script type="application/ld+json">
							{
								"@context": "https://schema.org",
								"@type": "WebSite",
								"name": "Example Local",
								"description": "Example Local home page metadata",
								"url": "https://example.test/"
							}
						</script>
						<meta property="og:title" content="Housing motion advances after late vote">
						<meta property="og:description" content="Councillors sent the housing motion to a final budget vote.">
						<meta name="twitter:title" content="Housing motion advances after late vote">
					</head>
					<body>
						<article>
							<p>Councillors sent the housing motion to a final budget vote after staff said shelter capacity remained under pressure.</p>
							<p>The amendment asks staff to report on vacant public land and construction timelines before the summer recess.</p>
							<p>Advocates said the plan still needs operating money before new units can open.</p>
						</article>
					</body>
				</html>
			`,
				'text/html',
				'https://example.test/news/housing-motion'
			)
		);

		expect(items[0]).toMatchObject({
			title: 'Housing motion advances after late vote',
			summary: 'Councillors sent the housing motion to a final budget vote.',
			metadata: {
				metadataSources: expect.arrayContaining(['opengraph', 'twitter'])
			},
			provenance: {
				extractionMethod: 'readability'
			}
		});
		expect(items[0].title).not.toBe('Example Local');
	});

	it('keeps last-resort provenance when a section fallback supplies headline links', async () => {
		const items = await htmlArticleAdapter.extract(
			extractInput(
				`
				<html>
					<body>
						<main>
							<a href="/news/city-budget-vote">City budget vote moves ahead.</a>
							<a href="/news/hydro-repair-plan">Hydro repair plan faces review.</a>
						</main>
					</body>
				</html>
			`,
				'text/html',
				'https://example.test/news'
			)
		);

		expect(items[0].contentText).toContain('https://example.test/news/city-budget-vote');
		expect(items[0].provenance).toMatchObject({
			adapter: 'html_article',
			extractionMethod: 'metadata_summary_fallback'
		});
	});

	it('extracts text from simple PDF text operators', async () => {
		const items = await pdfAdapter.extract(
			extractInput(
				`%PDF-1.7
				1 0 obj << /Title (Budget briefing) >>
				stream
				BT (Budget briefing confirms new capital spending.) Tj [(Second paragraph ) (adds context.)] TJ ET
				endstream`,
				'application/pdf',
				'https://example.test/budget.pdf'
			)
		);

		expect(items[0]).toMatchObject({
			title: 'Budget briefing',
			provenance: { adapter: 'pdf' }
		});
		expect(items[0].contentText).toContain('Budget briefing confirms new capital spending');
		expect(items[0].contentText).toContain('Second paragraph adds context');
	});

	it('normalizes Bluesky feed API posts', async () => {
		const items = await blueskyAdapter.extract(
			extractInput(
				JSON.stringify({
					posts: [
						{
							uri: 'at://did:plc:abc/app.bsky.feed.post/3abc',
							author: { handle: 'editor.example.com' },
							record: {
								$type: 'app.bsky.feed.post',
								text: 'City hall committee just advanced the library funding motion.',
								createdAt: '2026-05-24T12:15:00Z'
							},
							indexedAt: '2026-05-24T12:16:00Z'
						}
					]
				}),
				'application/json',
				'https://bsky.social/xrpc/app.bsky.feed.getPosts'
			)
		);

		expect(items[0]).toMatchObject({
			url: 'https://bsky.app/profile/editor.example.com/post/3abc',
			summary: 'City hall committee just advanced the library funding motion.',
			publishedAt: '2026-05-24T12:15:00.000Z',
			provenance: { adapter: 'api_bluesky' }
		});
	});
});
