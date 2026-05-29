import { createHash } from 'node:crypto';
import { nowIso } from '../../util/ids.js';
import { politeFetch } from '../polite-fetch.js';
import type {
	SourceAdapter,
	SourceAdapterDiff,
	SourceAdapterExtractInput,
	SourceAdapterKind,
	SourceItem,
	SourceProvenance
} from './types.js';

export const adapterFetch: SourceAdapter['fetch'] = (url, options) => politeFetch(url, options);

export function sourceItem(
	kind: SourceAdapterKind,
	input: SourceAdapterExtractInput,
	item: {
		url: string;
		title: string;
		summary?: string;
		contentText?: string;
		publishedAt?: string | null;
		updatedAt?: string | null;
	}
): SourceItem {
	const title = cleanText(item.title) || sourceTitleFromUrl(item.url);
	const summary = cleanText(item.summary ?? '');
	const contentText = cleanText(item.contentText ?? (summary || title));
	return {
		id: sourceItemId(item.url, title),
		url: item.url,
		title,
		summary,
		contentText,
		publishedAt: item.publishedAt ?? null,
		updatedAt: item.updatedAt ?? null,
		provenance: sourceProvenance(kind, input, item.url)
	};
}

export function defaultDiff(previous: SourceItem[], next: SourceItem[]): SourceAdapterDiff {
	const previousByUrl = new Map(previous.map((item) => [item.url, item]));
	const nextByUrl = new Map(next.map((item) => [item.url, item]));
	const added: SourceItem[] = [];
	const updated: SourceItem[] = [];
	const unchanged: SourceItem[] = [];
	const removed: SourceItem[] = [];

	for (const item of next) {
		const existing = previousByUrl.get(item.url);
		if (!existing) {
			added.push(item);
		} else if (itemSignature(existing) !== itemSignature(item)) {
			updated.push(item);
		} else {
			unchanged.push(item);
		}
	}
	for (const item of previous) {
		if (!nextByUrl.has(item.url)) removed.push(item);
	}
	return { added, updated, removed, unchanged };
}

export function cleanText(value: string): string {
	return decodeXmlEntities(stripTags(unwrapCdata(value))).replace(/\s+/g, ' ').trim();
}

export function tagText(body: string, tag: string): string | null {
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = body.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
	return match ? cleanText(match[1]) : null;
}

export function attrValue(attrs: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'));
	return match ? decodeXmlEntities(match[1]).trim() : null;
}

export function absoluteUrl(value: string | null, baseUrl: string): string | null {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

export function dateText(value: string | null): string | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) return value;
	return new Date(timestamp).toISOString();
}

export function sourceTitleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
	} catch {
		return url;
	}
}

export function hostMatches(url: string, hosts: string[]): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
	} catch {
		return false;
	}
}

function sourceProvenance(kind: SourceAdapterKind, input: SourceAdapterExtractInput, itemUrl: string): SourceProvenance {
	return {
		adapter: kind,
		sourceUrl: input.url,
		discoveredAt: nowIso(),
		fetchedAt: input.fetchedAt,
		contentType: input.contentType,
		statusCode: input.statusCode,
		contentHash: input.contentHash,
		archiveSnapshotUrl: sameUrl(input.url, itemUrl) ? input.archiveSnapshotUrl ?? null : null,
		etag: input.cache?.etag ?? null,
		lastModified: input.cache?.lastModified ?? null
	};
}

function sameUrl(left: string, right: string): boolean {
	try {
		return new URL(left).toString() === new URL(right).toString();
	} catch {
		return left === right;
	}
}

function sourceItemId(url: string, title: string): string {
	return createHash('sha256').update(`${url}\n${title}`).digest('hex');
}

function itemSignature(item: SourceItem): string {
	return createHash('sha256')
		.update([item.title, item.summary, item.contentText, item.publishedAt, item.updatedAt].join('\n'))
		.digest('hex');
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, ' ');
}

function unwrapCdata(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}
