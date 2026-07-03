import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSourceUrl, extractSourceText, sourceFromText } from '../src/tools/sources.js';
import { NEWSCRAFT_USER_AGENT, politeFetch, resetPoliteFetchStateForTests } from '../src/tools/polite-fetch.js';

afterEach(() => {
	resetPoliteFetchStateForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('source extraction', () => {
	it('summarizes section pages as headline lists instead of navigation text', () => {
		const html = `
			<html>
				<head><title>Political News | Local & Canadian Politics News and Headlines</title></head>
				<body>
					<nav>
						<a href="/subscribe">Subscribe</a>
						<a href="/search">Search</a>
						<a href="#content">Skip to main content</a>
					</nav>
					<main id="content">
						<a href="/politics/carney-energy-plan">Carney says Canada energy plan will move quickly after premiers meeting</a>
						<a href="/news/canada-tariff-response">Ottawa weighs Canadian tariff response as U.S. talks continue</a>
						<a href="/news/alberta-cabinet">Jason Nixon named Alberta&#x27;s new finance minister in cabinet shakeup</a>
						<a href="/news/pipeline-review-2026">Pipeline review faces new questions from provinces and industry groups</a>
					</main>
				</body>
			</html>
		`;

		const text = extractSourceText(html, 'text/html', 'https://example.test/politics');

		expect(text).toContain('Carney says Canada energy plan');
		expect(text).toContain('https://example.test/politics/carney-energy-plan');
		expect(text).toContain('Ottawa weighs Canadian tariff response');
		expect(text).toContain("Alberta's new finance minister");
		expect(text).not.toContain('Subscribe');
		expect(text).not.toContain('Skip to main content');
	});

	it('extracts CBC-style story text without header, sharing, newsletter, or footer chrome', () => {
		const html = `
			<html>
				<head><title>School lunch pilot expands in Ottawa | CBC News</title></head>
				<body>
					<header>
						<a href="#content">Skip to main content</a>
						<div>CBC News Loaded Home News Canada World Politics Business Health Entertainment Sports Weather Search Subscribe Sign In</div>
					</header>
					<main id="content">
						<article>
							<h1>School lunch pilot expands in Ottawa after council vote</h1>
							<p>Ottawa councillors approved a larger school lunch pilot Tuesday after staff said demand had doubled since January.</p>
							<div class="share-tools">Share this story Copy link Facebook X Reddit</div>
							<p>The city said the next phase will add 12 schools and prioritize neighbourhoods where food bank use has climbed.</p>
							<div class="newsletter-signup">Sign up for the CBC Ottawa newsletter and download our app.</div>
						</article>
					</main>
					<footer>Copyright CBC/Radio-Canada. All rights reserved. Privacy Policy Terms of Use</footer>
				</body>
			</html>
		`;

		const text = extractSourceText(html, 'text/html', 'https://www.cbc.ca/news/canada/ottawa/story');

		expect(text).toContain('School lunch pilot expands in Ottawa');
		expect(text).toContain('councillors approved a larger school lunch pilot');
		expect(text).toContain('add 12 schools');
		expect(text).not.toMatch(/Skip to main content|CBC News Loaded|Subscribe|Sign In|Share this story|newsletter|Copyright/);
	});

	it('extracts CTV-style story text while removing menus and related/trending blocks', () => {
		const html = `
			<html>
				<body>
					<div class="site-menu">CTV News Channel Local News Video Weather Search Sign In Subscribe</div>
					<main>
						<article>
							<h1>Province opens review of emergency room wait times</h1>
							<p>The province has opened a review of emergency room wait times after new figures showed several hospitals missed targets.</p>
							<p>Health officials said the review will focus on staffing, triage rules and patient transfers between regional hospitals.</p>
							<section class="related-stories">Related Stories More from CTV News Video Latest newsletters</section>
						</article>
					</main>
					<footer>CTV News Programs Contact Privacy Policy Advertise with us</footer>
				</body>
			</html>
		`;

		const text = extractSourceText(html, 'text/html', 'https://www.ctvnews.ca/canada/story');

		expect(text).toContain('Province opens review of emergency room wait times');
		expect(text).toContain('staffing, triage rules and patient transfers');
		expect(text).not.toMatch(/CTV News Channel|Sign In|Related Stories|Privacy Policy|Advertise/);
	});

	it('extracts Global-style story text without social, app, and footer boilerplate', () => {
		const html = `
			<html>
				<body>
					<nav>Global News Home Canada World Politics Money Health Entertainment Sports Search Menu</nav>
					<article>
						<h1>Flood repairs begin on highway after weekend storm</h1>
						<p>Repair crews began rebuilding a washed-out section of highway Monday after a weekend storm closed the route.</p>
						<div aria-label="share this article">Share this article Facebook Twitter Reddit Email</div>
						<p>The transportation ministry said one lane could reopen by Friday if water levels keep falling.</p>
						<div class="app-promo">Download the Global News app and sign up for breaking news alerts.</div>
					</article>
					<footer>Global News copyright Corus Entertainment Inc. All rights reserved Terms Privacy</footer>
				</body>
			</html>
		`;

		const text = extractSourceText(html, 'text/html', 'https://globalnews.ca/news/highway-flood-repairs/');

		expect(text).toContain('Flood repairs begin on highway after weekend storm');
		expect(text).toContain('one lane could reopen by Friday');
		expect(text).not.toMatch(/Global News Home|Share this article|Download the Global News app|copyright|Terms Privacy/);
	});

	it('caps provided source text and summary to bounded sizes', () => {
		const source = sourceFromText(
			'https://example.test/long',
			Array.from({ length: 400 }, (_, index) => `Paragraph ${index} says the same long report detail should not expand forever.`).join('\n'),
			'Long fixture'
		);

		expect(source.contentText.length).toBeLessThanOrEqual(8000);
		expect(source.summary.length).toBeLessThanOrEqual(420);
		expect(source.snippet.length).toBeLessThanOrEqual(600);
	});

	it('preserves fetched source shape through the polite fetch path', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith('/robots.txt')) {
				return new Response('', { status: 404 });
			}

			return new Response(
				`
					<html>
						<head><title>Water system repairs approved</title></head>
						<body>
							<article>
								<p>Council approved urgent water system repairs after engineers found several valves were near failure.</p>
								<p>The project will begin next month and remain within the existing capital budget.</p>
							</article>
						</body>
					</html>
				`,
				{
					status: 200,
					headers: { 'content-type': 'text/html', etag: '"story"' }
				}
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const source = await fetchSourceUrl('https://example.test/water-repairs');
		const storyCall = fetchMock.mock.calls.find((call) => String(call[0]) === 'https://example.test/water-repairs');
		const headers = new Headers(storyCall?.[1]?.headers);

		expect(headers.get('user-agent')).toBe(NEWSCRAFT_USER_AGENT);
		expect(source).toMatchObject({
			url: 'https://example.test/water-repairs',
			title: 'Water system repairs approved',
			contentType: 'text/html',
			statusCode: 200,
			used: true
		});
		expect(source.robots).toMatchObject({ checked: true, allowed: true });
		expect(source.contentText).toContain('Council approved urgent water system repairs');
		expect(source.snippet.length).toBeLessThanOrEqual(600);
		expect(source.contentHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it('blocks localhost and private network fetch targets before fetching', async () => {
		const fetchMock = vi.fn(async () => new Response('should not fetch'));

		await expect(politeFetch('http://127.0.0.1/admin', { fetchImpl: fetchMock })).rejects.toThrow(
			/Blocked private fetch target/
		);
		await expect(politeFetch('http://localhost/admin', { fetchImpl: fetchMock })).rejects.toThrow(
			/Blocked private fetch target/
		);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('blocks hostnames that resolve to private addresses', async () => {
		const fetchMock = vi.fn(async () => new Response('should not fetch'));

		await expect(
			politeFetch('https://metadata.example/story', {
				fetchImpl: fetchMock,
				ssrf: { resolveHost: async () => ['169.254.169.254'] }
			})
		).rejects.toThrow(/Blocked private fetch target/);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('preserves structured article metadata and extraction provenance on fetched sources', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/robots.txt')) return new Response('', { status: 404 });
				return new Response(
					`
					<html>
						<head>
							<meta property="og:site_name" content="Example Local">
							<script type="application/ld+json">
								{
									"@context": "https://schema.org",
									"@type": "NewsArticle",
									"headline": "Library branch hours extended after budget vote",
									"description": "Council added evening hours at three library branches.",
									"articleBody": "Council added evening hours at three library branches after trustees reported a jump in after-school demand. The budget amendment funds extra staffing through the end of the year and requires a usage report before renewal. Library officials said the schedule starts next month and focuses on neighbourhoods with fewer recreation spaces.",
									"datePublished": "2026-05-25T14:00:00Z"
								}
							</script>
						</head>
						<body><article><p>Fallback paragraph should not replace the structured body.</p></article></body>
					</html>
				`,
					{ status: 200, headers: { 'content-type': 'text/html' } }
				);
			})
		);

		const source = await fetchSourceUrl('https://example.test/library-hours');

		expect(source).toMatchObject({
			title: 'Library branch hours extended after budget vote',
			summary: 'Council added evening hours at three library branches.',
			metadata: {
				publishedAt: '2026-05-25T14:00:00.000Z',
				siteName: 'Example Local',
				metadataSources: expect.arrayContaining(['json_ld', 'opengraph'])
			},
			provenance: {
				adapter: 'html_article',
				extractionMethod: 'json_ld_article_body',
				metadataSources: expect.arrayContaining(['json_ld', 'opengraph']),
				structuredType: 'NewsArticle'
			}
		});
		expect(source.contentText).toContain('requires a usage report before renewal');
		expect(source.contentText).not.toContain('Fallback paragraph');
	});

	it('carries feed item publication dates in source text instead of fetch time', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).endsWith('/robots.txt')) return new Response('', { status: 404 });
				return new Response(
					`
					<rss>
						<channel>
							<item>
								<title>Transit agency posts weekend service update</title>
								<link>https://example.test/transit-update</link>
								<description>Shuttle buses will replace part of the line this weekend.</description>
								<pubDate>Sat, 30 May 2026 13:00:00 GMT</pubDate>
							</item>
						</channel>
					</rss>
					`,
					{ status: 200, headers: { 'content-type': 'application/rss+xml' } }
				);
			})
		);

		const source = await fetchSourceUrl('https://example.test/feed.xml');

		expect(source.contentText).toContain('Published: 2026-05-30T13:00:00.000Z');
		expect(source.contentText).not.toContain(source.fetchedAt);
	});
});
