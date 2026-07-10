import { describe, expect, it } from 'vitest';
import { prepareAssistantMarkdown, renderMarkdownToHtml } from './markdown-render';

describe('markdown rendering', () => {
	it('renders rich GitHub-flavored Markdown blocks', () => {
		const html = renderMarkdownToHtml(
			[
				'# Brief',
				'',
				'- First update',
				'- Second update',
				'',
				'| Outlet | Update |',
				'| --- | --- |',
				'| [CBC](https://cbc.ca/news) | Published |',
				'',
				'```ts',
				'const published = true;',
				'```'
			].join('\n')
		);

		expect(html).toContain('<h1>Brief</h1>');
		expect(html).toContain('<ul>');
		expect(html).toContain('<table>');
		expect(html).toContain('href="https://cbc.ca/news"');
		expect(html).toContain('<code class="language-ts">');
		expect(html).toContain('const published = true;');
	});

	it('preserves inline citation links and caveats in assistant answers', () => {
		const html = renderMarkdownToHtml(
			prepareAssistantMarkdown(
				[
					'## What changed',
					'',
					'Police said the road reopened after the closure [CBC](https://www.cbc.ca/news/canada/toronto/story).',
					'',
					'Caveat: The paywalled source could not be read directly, so treat that detail as incomplete.'
				].join('\n')
			)
		);

		expect(html).toContain('href="https://www.cbc.ca/news/canada/toronto/story"');
		expect(html).toContain('CBC');
		expect(html).toContain('Caveat:');
		expect(html).toContain('paywalled source could not be read directly');
	});

	it('sanitizes unsafe HTML and link URLs', () => {
		const html = renderMarkdownToHtml(
			'Before <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [**formatted bad**](javascript:alert(2)) [ok](https://example.com). ![x](javascript:alert(1))'
		);

		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('javascript:');
		expect(html).toContain('&lt;img');
		expect(html).toContain('bad');
		expect(html).toContain('formatted bad');
		expect(html).toContain('href="https://example.com"');
	});

	it('removes generated implementation tails without stripping body citations or caveats', () => {
		const prepared = prepareAssistantMarkdown(
			[
				'The mayor confirmed the vote [CTV News](https://www.ctvnews.ca/politics/story).',
				'',
				'Caveat: The official minutes were not posted yet.',
				'',
				'## Sources',
				'- [Debug source](https://example.com/internal)',
				'Unique tail marker should not surface.'
			].join('\n')
		);
		const html = renderMarkdownToHtml(prepared);

		expect(prepared).not.toContain('Unique tail marker should not surface');
		expect(html).toContain('href="https://www.ctvnews.ca/politics/story"');
		expect(html).toContain('Caveat: The official minutes were not posted yet.');
	});
});
