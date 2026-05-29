import { extractArticle } from '../article-extraction.js';
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
	const article = extractArticle(input.body, input.url);
	const fallbackText = extractSourceText(input.body, input.contentType, input.url);
	const text =
		article.provenance.extractionMethod === 'metadata_summary_fallback' && fallbackText.length > article.contentText.length
			? fallbackText
			: article.contentText || fallbackText;
	return [
		sourceItem('html_article', input, {
			url: input.url,
			title: article.title || extractTitle(input.body) || new URL(input.url).hostname,
			summary: article.summary || text.split(/\n+/).find((line) => line.trim().length > 40) || text.slice(0, 240),
			contentText: text,
			publishedAt: article.publishedAt,
			updatedAt: article.updatedAt,
			metadata: {
				title: article.metadata.title,
				description: article.metadata.description,
				canonicalUrl: article.metadata.canonicalUrl,
				siteName: article.metadata.siteName,
				publishedAt: article.metadata.publishedAt,
				updatedAt: article.metadata.updatedAt,
				authors: article.metadata.authors,
				image: article.metadata.image,
				section: article.metadata.section,
				keywords: article.metadata.keywords,
				structuredType: article.metadata.structuredType,
				metadataSources: article.metadata.metadataSources
			},
			extractionMethod: article.provenance.extractionMethod,
			metadataSources: article.provenance.metadataSources,
			structuredType: article.provenance.structuredType,
			canonicalUrl: article.provenance.canonicalUrl
		})
	];
}
