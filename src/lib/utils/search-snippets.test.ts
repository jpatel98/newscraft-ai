import { describe, expect, it } from 'vitest';
import { markSearchSnippet, visibleSearchSnippet } from './search-snippets';

describe('markSearchSnippet', () => {
	it('marks matching terms in visible text', () => {
		expect(markSearchSnippet('Toronto budget update', ['toronto', 'budget'])).toBe(
			'<mark>Toronto</mark> <mark>budget</mark> update'
		);
	});

	it('clips long snippets around the first match', () => {
		const text = `${'intro '.repeat(20)}Toronto budget update`;
		const snippet = markSearchSnippet(text, ['toronto'], 40);
		expect(snippet.startsWith('…')).toBe(true);
		expect(snippet).toContain('<mark>Toronto</mark>');
	});
});

describe('visibleSearchSnippet', () => {
	it('drops matches that only exist in hidden serialized payloads', () => {
		expect(visibleSearchSnippet('', ['image', 'jpeg', 'base64'])).toBeNull();
	});

	it('requires every search token to appear in visible text', () => {
		expect(visibleSearchSnippet('Budget update', ['budget', 'toronto'])).toBeNull();
	});
});
