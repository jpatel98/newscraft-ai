import { createHash } from 'node:crypto';
import { nowIso } from '../util/ids.js';

export interface FetchedSource {
	url: string;
	title: string;
	fetchedAt: string;
	snippet: string;
	summary: string;
	contentText: string;
	contentHash: string;
	contentType: string | null;
	statusCode: number | null;
	used: boolean;
}

export async function fetchSourceUrl(url: string, signal?: AbortSignal): Promise<FetchedSource> {
	const response = await fetch(url, {
		headers: {
			'user-agent': 'NewsCraft newsroom-harness/0.0.1 (+https://newscraft.ai)'
		},
		signal
	});
	const contentType = response.headers.get('content-type');
	const body = await response.text();
	const text = contentType?.includes('xml') || looksLikeFeed(body) ? summarizeFeed(body) : htmlToText(body);
	const title = extractTitle(body) || new URL(url).hostname;
	const cleaned = normalizeWhitespace(text).slice(0, 20_000);
	const snippet = cleaned.slice(0, 600);
	return {
		url,
		title,
		fetchedAt: nowIso(),
		snippet,
		summary: summarizeText(cleaned),
		contentText: cleaned,
		contentHash: createHash('sha256').update(body).digest('hex'),
		contentType,
		statusCode: response.status,
		used: response.ok
	};
}

export function sourceFromText(url: string, text: string, title = 'Provided source'): FetchedSource {
	const cleaned = normalizeWhitespace(text).slice(0, 20_000);
	return {
		url,
		title,
		fetchedAt: nowIso(),
		snippet: cleaned.slice(0, 600),
		summary: summarizeText(cleaned),
		contentText: cleaned,
		contentHash: createHash('sha256').update(text).digest('hex'),
		contentType: 'text/plain',
		statusCode: 200,
		used: true
	};
}

function looksLikeFeed(body: string): boolean {
	return /<(rss|feed|entry|item)\b/i.test(body.slice(0, 2000));
}

function summarizeFeed(xml: string): string {
	const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi)]
		.slice(0, 8)
		.map((match) => {
			const item = match[0];
			const title = tagText(item, 'title') || 'Untitled item';
			const description = tagText(item, 'description') || tagText(item, 'summary') || tagText(item, 'content') || '';
			return `${title}. ${description}`;
		});
	return items.length ? items.join('\n\n') : htmlToText(xml);
}

function extractTitle(body: string): string | null {
	return tagText(body, 'title') || metaContent(body, 'og:title') || metaContent(body, 'twitter:title');
}

function tagText(body: string, tag: string): string | null {
	const match = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
	return match ? decodeEntities(stripTags(unwrapCdata(match[1]))).trim() : null;
}

function metaContent(body: string, property: string): string | null {
	const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = body.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'));
	return match ? decodeEntities(match[1]).trim() : null;
}

function htmlToText(html: string): string {
	return decodeEntities(
		stripTags(
			html
				.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
				.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
				.replace(/<\/(p|div|li|h[1-6]|article|section)>/gi, '\n')
		)
	);
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, ' ');
}

function unwrapCdata(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function summarizeText(value: string): string {
	const first = value.split(/(?<=[.!?])\s+/).find((sentence) => sentence.length > 40);
	return (first || value).slice(0, 280).trim();
}
