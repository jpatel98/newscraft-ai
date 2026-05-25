import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { absoluteUrl, adapterFetch, cleanText, defaultDiff, sourceItem } from './utils.js';

export const webSearchAdapter: SourceAdapter = {
	kind: 'web_search',
	canHandle({ url, contentType, body }) {
		return Boolean(
			url.includes('/search') ||
				new URL(url).searchParams.has('q') ||
				(contentType?.includes('json') && looksLikeSearchJson(body ?? ''))
		);
	},
	fetch: adapterFetch,
	discover: parseSearchResults,
	extract: parseSearchResults,
	diff: defaultDiff
};

function parseSearchResults(input: SourceAdapterExtractInput): SourceItem[] {
	const jsonItems = parseSearchJson(input);
	if (jsonItems.length) return jsonItems;
	return [...input.body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
		.slice(0, 80)
		.flatMap((match) => {
			const url = absoluteUrl(attrValue(match[1], 'href'), input.url);
			const title = cleanText(match[2]);
			if (!url || !title || title.length < 8) return [];
			return [
				sourceItem('web_search', input, {
					url,
					title,
					summary: `Search result for ${new URL(input.url).searchParams.get('q') || 'query'}`,
					contentText: `${title}. ${url}`
				})
			];
		})
		.slice(0, 20);
}

function parseSearchJson(input: SourceAdapterExtractInput): SourceItem[] {
	const parsed = parseJson(input.body);
	const records = Array.isArray(parsed)
		? parsed
		: Array.isArray(parsed?.results)
			? parsed.results
			: Array.isArray(parsed?.items)
				? parsed.items
				: Array.isArray(parsed?.web?.results)
					? parsed.web.results
					: [];
	return records
		.slice(0, 20)
		.flatMap((record: SearchRecord) => {
			const url = stringValue(record.url ?? record.link);
			const title = stringValue(record.title ?? record.name);
			const summary = stringValue(record.snippet ?? record.description ?? record.summary);
			if (!url || !title) return [];
			return [
				sourceItem('web_search', input, {
					url,
					title,
					summary,
					contentText: cleanText(`${title}. ${summary}. ${url}`)
				})
			];
		});
}

function looksLikeSearchJson(body: string): boolean {
	const parsed = parseJson(body);
	return Boolean(parsed && (Array.isArray(parsed.results) || Array.isArray(parsed.items) || Array.isArray(parsed.web?.results)));
}

function parseJson(value: string): any {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function attrValue(attrs: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'));
	return match ? match[1].trim() : null;
}

type SearchRecord = {
	url?: unknown;
	link?: unknown;
	title?: unknown;
	name?: unknown;
	snippet?: unknown;
	description?: unknown;
	summary?: unknown;
};
