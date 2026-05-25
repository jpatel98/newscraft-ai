import { createHash } from 'node:crypto';
import { nowIso } from '../util/ids.js';
import { assessSourceQuality } from '../util/source-quality.js';
import { politeFetch } from './polite-fetch.js';
import { selectSourceAdapter, type SourceAdapterKind, type SourceItem } from './source-adapters/index.js';

export { politeFetch, NEWSCRAFT_USER_AGENT } from './polite-fetch.js';
export {
	SOURCE_ADAPTERS,
	atomAdapter,
	htmlArticleAdapter,
	rssAdapter,
	selectSourceAdapter,
	sitemapAdapter
} from './source-adapters/index.js';
export type {
	SourceAdapter,
	SourceAdapterDiff,
	SourceAdapterExtractInput,
	SourceAdapterInput,
	SourceAdapterKind,
	SourceItem,
	SourceProvenance
} from './source-adapters/index.js';

const MAX_SOURCE_TEXT_CHARS = 8_000;
const MAX_SOURCE_SUMMARY_CHARS = 420;
const MAX_SOURCE_LINE_CHARS = 650;

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
	const fetched = await politeFetch(url, { signal });
	const contentType = fetched.contentType;
	const body = fetched.body;
	const adapter = selectSourceAdapter({ url, contentType, body });
	const adapterItems = await adapter.extract({
		url,
		body,
		contentType,
		fetchedAt: fetched.fetchedAt,
		statusCode: fetched.statusCode,
		contentHash: fetched.cache.contentHash,
		cache: fetched.cache
	});
	const text = sourceTextFromAdapter(adapter.kind, adapterItems, body, contentType, url);
	const title = extractTitle(body) || new URL(url).hostname;
	const cleaned = capText(cleanSourceText(text), MAX_SOURCE_TEXT_CHARS);
	const summary = summarizeText(cleaned);
	const quality = assessSourceQuality({ title, text: cleaned, summary, statusCode: fetched.statusCode });
	const usableText = quality.usable ? cleaned : '';
	const snippet = usableText.slice(0, 600);
	return {
		url,
		title,
		fetchedAt: fetched.fetchedAt,
		snippet,
		summary: quality.usable ? summary : '',
		contentText: usableText,
		contentHash: fetched.cache.contentHash,
		contentType,
		statusCode: fetched.statusCode,
		used: fetched.ok && quality.usable
	};
}

export function extractSourceText(body: string, contentType: string | null, url: string): string {
	if (contentType?.includes('xml') || looksLikeFeed(body)) return cleanSourceText(summarizeFeed(body));
	return cleanSourceText(summarizeHeadlineLinks(body, url) || htmlToText(body));
}

function sourceTextFromAdapter(
	kind: SourceAdapterKind,
	items: SourceItem[],
	body: string,
	contentType: string | null,
	url: string
): string {
	if (!items.length) return extractSourceText(body, contentType, url);
	if (kind === 'sitemap') return items.map((item) => `${item.title}. ${item.url}`).join('\n');
	if (kind === 'rss' || kind === 'atom') {
		return items
			.slice(0, 8)
			.map((item) => `${item.title}. ${item.summary || item.contentText}`)
			.join('\n\n');
	}
	return items[0]?.contentText || extractSourceText(body, contentType, url);
}

export function sourceFromText(url: string, text: string, title = 'Provided source'): FetchedSource {
	const cleaned = capText(cleanSourceText(text), MAX_SOURCE_TEXT_CHARS);
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

export function extractTitle(body: string): string | null {
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
	const articleHtml = bestStoryContainer(pruneHtmlNoise(html));
	return decodeEntities(
		stripTags(
			articleHtml
				.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
				.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/<\/(p|div|li|h[1-6]|article|section|main|blockquote)>/gi, '\n')
		)
	);
}

function pruneHtmlNoise(html: string): string {
	let pruned = html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
		.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ');

	for (const tag of ['header', 'nav', 'footer', 'aside', 'form']) {
		pruned = removeTagBlocks(pruned, tag);
	}

	pruned = removeAttributeNoiseBlocks(pruned);
	return pruned;
}

function removeTagBlocks(html: string, tag: string): string {
	return html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
}

function removeAttributeNoiseBlocks(html: string): string {
	const noiseAttrs =
		'(?:nav|navigation|menu|header|footer|masthead|skip-link|subscribe|signin|sign-in|login|newsletter|share|social|promo|advert|ad-|comments|related|trending|recommended|site-theme|theme-toggle|weather-widget)';
	return html.replace(
		new RegExp(
			`<([a-z][\\w:-]*)\\b[^>]*(?:(?:class|id|role|aria-label)=["'][^"']*${noiseAttrs}[^"']*["'])[^>]*>[\\s\\S]*?<\\/\\1>`,
			'gi'
		),
		' '
	);
}

function bestStoryContainer(html: string): string {
	const candidates = [
		...elementMatches(html, 'article'),
		...elementMatches(html, 'main'),
		...roleMainMatches(html)
	].sort((left, right) => textLength(right) - textLength(left));
	const best = candidates[0];
	return best && textLength(best) >= 500 ? best : html;
}

function elementMatches(html: string, tag: string): string[] {
	return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'))].map((match) => match[0]);
}

function roleMainMatches(html: string): string[] {
	return [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*role=["']main["'][^>]*>[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
}

function textLength(html: string): number {
	return normalizeWhitespace(stripTags(html)).length;
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
	if (lines.length >= 2) return capText(lines.slice(0, 3).join(' '), MAX_SOURCE_SUMMARY_CHARS);
	const first = value.split(/(?<=[.!?])\s+/).find((sentence) => sentence.length > 40);
	return capText(first || value, MAX_SOURCE_SUMMARY_CHARS);
}

function cleanSourceText(value: string): string {
	const seen = new Set<string>();
	const lines = value
		.replace(/\r/g, '\n')
		.split(/\n+/)
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean)
		.filter((line) => !isNoiseLine(line))
		.map((line) => capText(line, MAX_SOURCE_LINE_CHARS))
		.filter((line) => {
			const key = canonicalLine(line);
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		});

	return lines.join('\n').trim();
}

function isNoiseLine(line: string): boolean {
	const normalized = line.toLowerCase();
	if (line.length <= 2) return true;
	if (/^(?:skip to|skip directly to|jump to)\b/.test(normalized)) return true;
	if (/^(?:menu|open menu|close menu|search|subscribe|sign in|log in|login|create account|my account)$/.test(normalized)) {
		return true;
	}
	if (/^(?:share|share this story|copy link|print|email|facebook|x|twitter|reddit|linkedin|whatsapp)$/.test(normalized)) {
		return true;
	}
	if (/^(?:listen to this article|read more|more from|advertisement|advertising|sponsored content)$/.test(normalized)) {
		return true;
	}
	if (/\b(?:copyright|all rights reserved|privacy policy|terms of use|terms and conditions|cookie policy)\b/.test(normalized)) {
		return true;
	}
	if (/\b(?:newsletter|sign up for|get breaking news alerts|download our app|download the app)\b/.test(normalized)) {
		return true;
	}
	if (/\b(?:site theme|theme toggle|light mode|dark mode|system mode)\b/.test(normalized)) return true;
	if (line.length < 180 && navTokenCount(normalized) >= 5) return true;
	if (line.length < 220 && /^(?:cbc|ctv|global news)\b/.test(normalized) && navTokenCount(normalized) >= 4) return true;
	return false;
}

function navTokenCount(normalized: string): number {
	const tokens = [
		'home',
		'news',
		'canada',
		'world',
		'politics',
		'business',
		'health',
		'entertainment',
		'sports',
		'weather',
		'video',
		'radio',
		'live',
		'local',
		'menu',
		'search',
		'subscribe'
	];
	return tokens.filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(normalized)).length;
}

function canonicalLine(line: string): string {
	return line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function capText(value: string, maxLength: number): string {
	const normalized = value.trim();
	if (normalized.length <= maxLength) return normalized;
	return normalized.slice(0, maxLength).trim();
}
