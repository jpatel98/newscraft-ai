import { describe, expect, it } from 'vitest';
import { extractSourceText, sourceFromText } from '../src/tools/sources.js';

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
});
