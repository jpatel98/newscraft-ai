import { createHash } from 'node:crypto';
import { nowIso } from '../util/ids.js';
import { assessSourceQuality } from '../util/source-quality.js';

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
	const text = extractSourceText(body, contentType, url);
	const title = extractTitle(body) || new URL(url).hostname;
	const cleaned = normalizeWhitespace(text).slice(0, 20_000);
	const summary = summarizeText(cleaned);
	const quality = assessSourceQuality({ title, text: cleaned, summary, statusCode: response.status });
	const usableText = quality.usable ? cleaned : '';
	const snippet = usableText.slice(0, 600);
	return {
		url,
		title,
		fetchedAt: nowIso(),
		snippet,
		summary: quality.usable ? summary : '',
		contentText: usableText,
		contentHash: createHash('sha256').update(body).digest('hex'),
		contentType,
		statusCode: response.status,
		used: response.ok && quality.usable
	};
}

export function extractSourceText(body: string, contentType: string | null, url: string): string {
	if (contentType?.includes('xml') || looksLikeFeed(body)) return summarizeFeed(body);
	return summarizeHeadlineLinks(body, url) || htmlToText(body);
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

function summarizeHeadlineLinks(html: string, pageUrl: string): string {
	const seen = new Set<string>();
	const candidates = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
		.map((match, index) => {
			const href = attrValue(match[1], 'href');
			const title = normalizeWhitespace(decodeEntities(stripTags(unwrapCdata(match[2]))));
			if (!href || !isLikelyHeadline(title, href)) return null;
			const absoluteUrl = absoluteHref(href, pageUrl);
			if (!absoluteUrl) return null;
			const key = title.toLowerCase();
			if (seen.has(key)) return null;
			seen.add(key);
			return { title, url: absoluteUrl, index, score: headlineScore(title, absoluteUrl) };
		})
		.filter((candidate): candidate is { title: string; url: string; index: number; score: number } =>
			Boolean(candidate)
		)
		.filter((candidate) => candidate.score >= 2)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, 10);

	if (candidates.length < 2) return '';
	return candidates.map((candidate) => `${candidate.title}. ${candidate.url}`).join('\n');
}

function attrValue(attrs: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'));
	return match ? decodeEntities(match[1]).trim() : null;
}

function absoluteHref(href: string, pageUrl: string): string | null {
	if (/^(?:javascript|mailto|tel):/i.test(href) || href.startsWith('#')) return null;
	try {
		return new URL(href, pageUrl).toString();
	} catch {
		return null;
	}
}

function isLikelyHeadline(title: string, href: string): boolean {
	if (!title || title.length < 28 || title.length > 220) return false;
	const normalized = title.toLowerCase();
	if (
		/\b(skip to|sign in|subscribe|download our app|site theme|search|sections|advertise|privacy|terms|contact us|newsletter)\b/i.test(
			normalized
		)
	) {
		return false;
	}
	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length < 4) return false;
	if (new Set(words).size <= 3) return false;
	if (/^https?:\/\//i.test(title)) return false;
	if (/\/(?:privacy|terms|contact|about|account|login|signin|subscribe)(?:\/|$)/i.test(href)) return false;
	return true;
}

function headlineScore(title: string, url: string): number {
	let score = 0;
	const normalizedUrl = url.toLowerCase();
	if (/\/(?:news|politics|world|canada|business|article)\//.test(normalizedUrl)) score += 2;
	if (/\b(?:canada|canadian|ottawa|parliament|carney|trump|energy|pipeline|tariff|minister)\b/i.test(title)) {
		score += 1;
	}
	if (/[.!?]$/.test(title)) score += 1;
	if (/\d/.test(title)) score += 1;
	return score;
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
		.replace(/&#39;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function summarizeText(value: string): string {
	const lines = value
		.split(/\n+/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length >= 2) return lines.slice(0, 3).join(' ');
	const first = value.split(/(?<=[.!?])\s+/).find((sentence) => sentence.length > 40);
	return (first || value).slice(0, 280).trim();
}
