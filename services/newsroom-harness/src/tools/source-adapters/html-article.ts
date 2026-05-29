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
	discover: discoverHtmlArticleLinks,
	extract: extractHtmlArticle,
	diff: defaultDiff
};

function extractHtmlArticle(input: SourceAdapterExtractInput): SourceItem[] {
	return [htmlArticleItem(input)];
}

function htmlArticleItem(input: SourceAdapterExtractInput): SourceItem {
	const article = extractArticle(input.body, input.url);
	const fallbackText = extractSourceText(input.body, input.contentType, input.url);
	const text =
		article.provenance.extractionMethod === 'metadata_summary_fallback' && fallbackText.length > article.contentText.length
			? fallbackText
			: article.contentText || fallbackText;
	return sourceItem('html_article', input, {
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
	});
}

function discoverHtmlArticleLinks(input: SourceAdapterExtractInput): SourceItem[] {
	const article = htmlArticleItem(input);
	if (isLikelyStandaloneArticle(article)) return [article];
	const links = discoverHeadlineLinks(input);
	return links.length ? links : [article];
}

function isLikelyStandaloneArticle(item: SourceItem): boolean {
	const method = item.provenance.extractionMethod;
	if (item.publishedAt || item.updatedAt) return true;
	if (item.metadata?.structuredType && /article|posting/i.test(item.metadata.structuredType)) return true;
	return method !== 'metadata_summary_fallback' && item.contentText.length >= 600;
}

function discoverHeadlineLinks(input: SourceAdapterExtractInput): SourceItem[] {
	const seen = new Set<string>();
	return [...input.body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
		.map((match, index) => {
			const href = attrValue(match[1], 'href');
			const title = cleanLinkText(match[2]);
			const url = absoluteHref(href, input.url);
			if (!url || !isLikelyHeadline(title, url, input.url)) return null;
			const key = normalizedUrlKey(url);
			if (seen.has(key)) return null;
			seen.add(key);
			return { title, url, index, score: headlineScore(title, url) };
		})
		.filter((candidate): candidate is { title: string; url: string; index: number; score: number } => Boolean(candidate))
		.filter((candidate) => candidate.score >= 2)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, 20)
		.map((candidate) =>
			sourceItem('html_article', input, {
				url: candidate.url,
				title: candidate.title,
				summary: candidate.title,
				contentText: candidate.title
			})
		);
}

function attrValue(attrs: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, 'i'));
	return match ? decodeEntities(match[1]).trim() : null;
}

function absoluteHref(href: string | null, baseUrl: string): string | null {
	if (!href || /^(?:javascript|mailto|tel):/i.test(href) || href.startsWith('#')) return null;
	try {
		return new URL(href, baseUrl).toString();
	} catch {
		return null;
	}
}

function cleanLinkText(value: string): string {
	return decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function isLikelyHeadline(title: string, url: string, sourceUrl: string): boolean {
	if (!title || title.length < 28 || title.length > 220) return false;
	if (/^https?:\/\//i.test(title)) return false;
	if (!sameSite(url, sourceUrl)) return false;
	if (/\b(skip to|sign in|subscribe|download our app|search|privacy|terms|contact us|newsletter)\b/i.test(title)) {
		return false;
	}
	const words = title.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length < 4 || new Set(words).size <= 3) return false;
	if (/\/(?:privacy|terms|contact|about|account|login|signin|subscribe)(?:\/|$)/i.test(url)) return false;
	return true;
}

function sameSite(url: string, sourceUrl: string): boolean {
	try {
		const parsed = new URL(url);
		const source = new URL(sourceUrl);
		return (
			(parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
			(parsed.hostname === source.hostname || parsed.hostname.endsWith(`.${source.hostname}`))
		);
	} catch {
		return false;
	}
}

function headlineScore(title: string, url: string): number {
	let score = 0;
	const normalizedUrl = url.toLowerCase();
	if (/\/(?:news|article|story|press|media|releases?|council)\//.test(normalizedUrl)) score += 2;
	if (/\b(?:announces?|approves?|launches?|confirms?|opens?|council|government|minister|world cup|fifa|canada|toronto|vancouver)\b/i.test(title)) {
		score += 1;
	}
	if (/[.!?:]$/.test(title)) score += 1;
	if (/\d/.test(title) || /202\d/.test(normalizedUrl)) score += 1;
	return score;
}

function normalizedUrlKey(value: string): string {
	try {
		const url = new URL(value);
		url.hash = '';
		url.search = '';
		return url.toString().replace(/\/$/, '').toLowerCase();
	} catch {
		return value.toLowerCase();
	}
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
