import { extractSourceText, extractTitle } from '../sources.js';
import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { adapterFetch, defaultDiff, sourceItem } from './utils.js';

export const htmlArticleAdapter: SourceAdapter = {
	kind: 'html_article',
	canHandle({ contentType, body }) {
		return Boolean(contentType?.includes('html') || /<html\b|<article\b|<main\b/i.test((body ?? '').slice(0, 4000)));
	},
	fetch: adapterFetch,
	discover: extractHtmlArticle,
	extract: extractHtmlArticle,
	diff: defaultDiff
};

function extractHtmlArticle(input: SourceAdapterExtractInput): SourceItem[] {
	const text = extractSourceText(input.body, input.contentType, input.url);
	return [
		sourceItem('html_article', input, {
			url: input.url,
			title: extractTitle(input.body) || new URL(input.url).hostname,
			summary: text.split(/\n+/).find((line) => line.trim().length > 40) || text.slice(0, 240),
			contentText: text
		})
	];
}
