import { describe, expect, it } from 'vitest';
import { extractSourceText } from '../src/tools/sources.js';

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
});
