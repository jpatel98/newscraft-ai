import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { adapterFetch, dateText, defaultDiff, sourceItem, sourceTitleFromUrl, tagText } from './utils.js';

export const sitemapAdapter: SourceAdapter = {
	kind: 'sitemap',
	canHandle({ contentType, body }) {
		const sample = (body ?? '').slice(0, 4000);
		return Boolean(contentType?.includes('sitemap') || /<urlset\b|<sitemapindex\b/i.test(sample));
	},
	fetch: adapterFetch,
	discover: parseSitemapItems,
	extract: parseSitemapItems,
	diff: defaultDiff
};

function parseSitemapItems(input: SourceAdapterExtractInput): SourceItem[] {
	const blocks = [
		...input.body.matchAll(/<url\b[\s\S]*?<\/url>/gi),
		...input.body.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi)
	];
	return blocks.slice(0, 100).flatMap((match) => sitemapItem(match[0], input));
}

function sitemapItem(xml: string, input: SourceAdapterExtractInput): SourceItem[] {
	const url = tagText(xml, 'loc');
	if (!url) return [];
	const updatedAt = dateText(tagText(xml, 'lastmod'));
	return [
		sourceItem('sitemap', input, {
			url,
			title: sourceTitleFromUrl(url),
			summary: updatedAt ? `Sitemap entry last modified ${updatedAt}` : 'Sitemap entry',
			contentText: url,
			updatedAt
		})
	];
}
