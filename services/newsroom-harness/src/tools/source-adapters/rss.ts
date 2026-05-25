import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { absoluteUrl, adapterFetch, cleanText, dateText, defaultDiff, sourceItem, tagText } from './utils.js';

export const rssAdapter: SourceAdapter = {
	kind: 'rss',
	canHandle({ contentType, body }) {
		return Boolean(contentType?.includes('rss') || /<rss\b|<item\b/i.test((body ?? '').slice(0, 4000)));
	},
	fetch: adapterFetch,
	discover: parseRssItems,
	extract: parseRssItems,
	diff: defaultDiff
};

function parseRssItems(input: SourceAdapterExtractInput): SourceItem[] {
	return [...input.body.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 50).map((match) => {
		const itemXml = match[0];
		const title = tagText(itemXml, 'title') || 'Untitled item';
		const url = absoluteUrl(tagText(itemXml, 'link') || tagText(itemXml, 'guid'), input.url) || input.url;
		const summary = tagText(itemXml, 'description') || tagText(itemXml, 'summary') || tagText(itemXml, 'content:encoded') || '';
		const publishedAt = dateText(tagText(itemXml, 'pubDate') || tagText(itemXml, 'published'));
		const updatedAt = dateText(tagText(itemXml, 'updated'));
		return sourceItem('rss', input, {
			url,
			title,
			summary,
			contentText: cleanText(`${title}. ${summary}`),
			publishedAt,
			updatedAt
		});
	});
}
