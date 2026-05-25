import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { absoluteUrl, adapterFetch, attrValue, cleanText, dateText, defaultDiff, sourceItem, tagText } from './utils.js';

export const atomAdapter: SourceAdapter = {
	kind: 'atom',
	canHandle({ contentType, body }) {
		return Boolean(contentType?.includes('atom') || /<feed\b|<entry\b/i.test((body ?? '').slice(0, 4000)));
	},
	fetch: adapterFetch,
	discover: parseAtomEntries,
	extract: parseAtomEntries,
	diff: defaultDiff
};

function parseAtomEntries(input: SourceAdapterExtractInput): SourceItem[] {
	return [...input.body.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].slice(0, 50).map((match) => {
		const entryXml = match[0];
		const title = tagText(entryXml, 'title') || 'Untitled entry';
		const url = atomEntryUrl(entryXml, input.url);
		const summary = tagText(entryXml, 'summary') || tagText(entryXml, 'content') || '';
		const publishedAt = dateText(tagText(entryXml, 'published'));
		const updatedAt = dateText(tagText(entryXml, 'updated'));
		return sourceItem('atom', input, {
			url,
			title,
			summary,
			contentText: cleanText(`${title}. ${summary}`),
			publishedAt,
			updatedAt
		});
	});
}

function atomEntryUrl(entryXml: string, feedUrl: string): string {
	const alternateLink = [...entryXml.matchAll(/<link\b([^>]*)>/gi)]
		.map((match) => ({
			href: attrValue(match[1], 'href'),
			rel: attrValue(match[1], 'rel')
		}))
		.find((link) => !link.rel || link.rel === 'alternate');
	return absoluteUrl(alternateLink?.href || tagText(entryXml, 'id'), feedUrl) || feedUrl;
}
