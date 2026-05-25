import { extractSourceText, extractTitle } from '../sources.js';
import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { adapterFetch, cleanText, dateText, defaultDiff, hostMatches, sourceItem } from './utils.js';

const PR_WIRE_HOSTS = ['prnewswire.com', 'businesswire.com', 'globenewswire.com'];

export const prWireAdapter: SourceAdapter = {
	kind: 'pr_wire',
	canHandle({ url, body }) {
		return hostMatches(url, PR_WIRE_HOSTS) || /\b(PR Newswire|Business Wire|GlobeNewswire)\b/i.test((body ?? '').slice(0, 4000));
	},
	fetch: adapterFetch,
	discover: extractPressRelease,
	extract: extractPressRelease,
	diff: defaultDiff
};

function extractPressRelease(input: SourceAdapterExtractInput): SourceItem[] {
	const title = extractTitle(input.body) || jsonLdValue(input.body, 'headline') || 'Press release';
	const publishedAt = dateText(jsonLdValue(input.body, 'datePublished') || metaContent(input.body, 'article:published_time'));
	const text = cleanText(extractSourceText(input.body, input.contentType, input.url));
	const dateline = datelineText(text);
	const summary = dateline ? `${dateline} ${firstSentence(text)}` : firstSentence(text);
	return [
		sourceItem('pr_wire', input, {
			url: input.url,
			title,
			summary,
			contentText: text,
			publishedAt,
			updatedAt: dateText(jsonLdValue(input.body, 'dateModified'))
		})
	];
}

function datelineText(text: string): string {
	const match = text.match(/^([A-Z][A-Z .,-]{8,80})\s+(?:,|-|--)\s+/);
	return match ? match[1].trim() : '';
}

function firstSentence(text: string): string {
	return text.split(/(?<=[.!?])\s+/).find((sentence) => sentence.length > 40)?.slice(0, 360) || text.slice(0, 360);
}

function jsonLdValue(html: string, key: string): string | null {
	for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			const parsed = JSON.parse(match[1]);
			const value = valueFromJsonLd(parsed, key);
			if (value) return value;
		} catch {
			continue;
		}
	}
	return null;
}

function valueFromJsonLd(value: unknown, key: string): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = valueFromJsonLd(item, key);
			if (found) return found;
		}
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record[key] === 'string') return record[key] as string;
		if (record['@graph']) return valueFromJsonLd(record['@graph'], key);
	}
	return null;
}

function metaContent(body: string, property: string): string | null {
	const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = body.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'));
	return match ? match[1].trim() : null;
}
