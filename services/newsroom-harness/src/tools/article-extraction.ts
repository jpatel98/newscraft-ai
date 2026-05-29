export type ArticleMetadataSource = 'json_ld' | 'schema_org' | 'opengraph' | 'twitter' | 'html';

export type ArticleExtractionMethod =
	| 'json_ld_article_body'
	| 'schema_article_body'
	| 'readability'
	| 'metadata_summary_fallback';

export interface ArticleMetadata {
	title: string | null;
	description: string | null;
	canonicalUrl: string | null;
	siteName: string | null;
	publishedAt: string | null;
	updatedAt: string | null;
	authors: string[];
	image: string | null;
	section: string | null;
	keywords: string[];
	structuredType: string | null;
	metadataSources: ArticleMetadataSource[];
	body: string | null;
}

export interface ArticleExtractionResult {
	title: string | null;
	summary: string;
	contentText: string;
	publishedAt: string | null;
	updatedAt: string | null;
	metadata: ArticleMetadata;
	provenance: {
		extractionMethod: ArticleExtractionMethod;
		metadataSources: ArticleMetadataSource[];
		structuredType: string | null;
		canonicalUrl: string | null;
	};
}

const ARTICLE_TYPE_PATTERN = /\b(?:newsarticle|reportagenewsarticle|analysisnewsarticle|article|blogposting)\b/i;
const MIN_ARTICLE_TEXT_CHARS = 160;
const MIN_ARTICLE_WORDS = 35;

export function extractArticle(html: string, url: string): ArticleExtractionResult {
	const metadata = extractArticleMetadata(html, url);
	const structuredBody = cleanReadableText(metadata.body || '');
	const readableText = extractReadableArticleText(html, url);
	const structuredBodyUsable = isUsableArticleText(structuredBody);
	const readableTextUsable = isUsableArticleText(readableText);
	let contentText = '';
	let extractionMethod: ArticleExtractionMethod = 'metadata_summary_fallback';

	if (structuredBodyUsable) {
		contentText = structuredBody;
		extractionMethod = metadata.metadataSources.includes('json_ld') ? 'json_ld_article_body' : 'schema_article_body';
	} else if (readableTextUsable) {
		contentText = readableText;
		extractionMethod = 'readability';
	} else {
		contentText = cleanReadableText([metadata.title, metadata.description].filter(Boolean).join('\n'));
	}

	return {
		title: metadata.title,
		summary: metadata.description || summarizeArticleText(contentText),
		contentText,
		publishedAt: metadata.publishedAt,
		updatedAt: metadata.updatedAt,
		metadata,
		provenance: {
			extractionMethod,
			metadataSources: metadata.metadataSources,
			structuredType: metadata.structuredType,
			canonicalUrl: metadata.canonicalUrl
		}
	};
}

export function extractArticleMetadata(html: string, url: string): ArticleMetadata {
	const jsonLd = jsonLdArticleMetadata(html, url);
	const schemaOrg = schemaOrgMetadata(html, url);
	const meta = metaTags(html);
	const sources = new Set<ArticleMetadataSource>();
	if (hasMetadata(jsonLd)) sources.add('json_ld');
	if (hasMetadata(schemaOrg)) sources.add('schema_org');
	if (hasAnyMeta(meta, 'og:')) sources.add('opengraph');
	if (hasAnyMeta(meta, 'twitter:')) sources.add('twitter');

	const htmlTitle = tagText(html, 'h1') || tagText(html, 'title');
	const canonicalUrl =
		jsonLd.canonicalUrl ||
		schemaOrg.canonicalUrl ||
		absoluteUrl(metaValue(meta, 'og:url'), url) ||
		linkHref(html, 'canonical', url);
	const title =
		jsonLd.title ||
		schemaOrg.title ||
		metaValue(meta, 'og:title') ||
		metaValue(meta, 'twitter:title') ||
		metaValue(meta, 'headline') ||
		htmlTitle;
	const description =
		jsonLd.description ||
		schemaOrg.description ||
		metaValue(meta, 'og:description') ||
		metaValue(meta, 'twitter:description') ||
		metaValue(meta, 'description');
	if (htmlTitle || canonicalUrl || metaValue(meta, 'description')) sources.add('html');

	return {
		title,
		description,
		canonicalUrl,
		siteName: metaValue(meta, 'og:site_name') || null,
		publishedAt:
			jsonLd.publishedAt ||
			schemaOrg.publishedAt ||
			dateText(metaValue(meta, 'article:published_time') || metaValue(meta, 'pubdate') || metaValue(meta, 'date')),
		updatedAt:
			jsonLd.updatedAt ||
			schemaOrg.updatedAt ||
			dateText(metaValue(meta, 'article:modified_time') || metaValue(meta, 'lastmod')),
		authors: uniqueStrings([
			...jsonLd.authors,
			...schemaOrg.authors,
			...allMetaValues(meta, 'article:author'),
			...allMetaValues(meta, 'author')
		]),
		image: jsonLd.image || schemaOrg.image || absoluteUrl(metaValue(meta, 'og:image') || metaValue(meta, 'twitter:image'), url),
		section: jsonLd.section || schemaOrg.section || metaValue(meta, 'article:section'),
		keywords: uniqueStrings([...jsonLd.keywords, ...schemaOrg.keywords, ...keywordsFromValue(metaValue(meta, 'keywords'))]),
		structuredType: jsonLd.structuredType || schemaOrg.structuredType || null,
		metadataSources: [...sources],
		body: jsonLd.body || schemaOrg.body || null
	};
}

export function extractReadableArticleText(html: string, _url: string): string {
	const pruned = pruneHtmlNoise(html);
	const candidates = readableCandidates(pruned)
		.map((fragment, index) => {
			const text = cleanReadableText(htmlFragmentToText(fragment));
			return { fragment, text, index, score: readabilityScore(fragment, text) };
		})
		.filter((candidate) => candidate.text.length > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);
	return candidates[0]?.text || cleanReadableText(htmlFragmentToText(pruned));
}

function jsonLdArticleMetadata(html: string, url: string): Partial<ArticleMetadata> & { authors: string[]; keywords: string[] } {
	const candidates = jsonLdObjects(html)
		.filter(isRecord)
		.map((record) => ({ record, score: jsonLdScore(record) }))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score);
	const best = candidates[0]?.record;
	if (!best) return emptyMetadata();
	return {
		title: fieldText(best, ['headline', 'name']),
		description: fieldText(best, ['description']),
		canonicalUrl: absoluteUrl(fieldText(best, ['url']) || mainEntityUrl(best), url),
		publishedAt: dateText(fieldText(best, ['datePublished', 'dateCreated'])),
		updatedAt: dateText(fieldText(best, ['dateModified', 'dateUpdated'])),
		authors: authorsFromValue(best.author ?? best.creator),
		image: absoluteUrl(imageFromValue(best.image), url),
		section: fieldText(best, ['articleSection']),
		keywords: keywordsFromValue(best.keywords),
		structuredType: structuredType(best),
		body: fieldText(best, ['articleBody'])
	};
}

function schemaOrgMetadata(html: string, url: string): Partial<ArticleMetadata> & { authors: string[]; keywords: string[] } {
	const structuredType = schemaItemType(html);
	const title = itempropValue(html, 'headline') || itempropValue(html, 'name');
	const description = itempropValue(html, 'description');
	const canonicalUrl = absoluteUrl(itempropValue(html, 'url') || itempropValue(html, 'mainEntityOfPage'), url);
	return {
		title,
		description,
		canonicalUrl,
		publishedAt: dateText(itempropValue(html, 'datePublished') || itempropValue(html, 'dateCreated')),
		updatedAt: dateText(itempropValue(html, 'dateModified') || itempropValue(html, 'dateUpdated')),
		authors: [itempropValue(html, 'author')].filter(isNonEmpty),
		image: absoluteUrl(itempropValue(html, 'image'), url),
		section: itempropValue(html, 'articleSection'),
		keywords: keywordsFromValue(itempropValue(html, 'keywords')),
		structuredType,
		body: itempropValue(html, 'articleBody')
	};
}

function jsonLdObjects(html: string): unknown[] {
	const values: unknown[] = [];
	for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		if (!/\btype\s*=\s*["']application\/ld\+json/i.test(match[1])) continue;
		const raw = unwrapCdata(match[2]).trim();
		for (const candidate of [raw, decodeEntities(raw)]) {
			try {
				values.push(...flattenJsonLd(JSON.parse(candidate)));
				break;
			} catch {
				continue;
			}
		}
	}
	return values;
}

function flattenJsonLd(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
	if (isRecord(value)) {
		const graph = value['@graph'];
		return graph ? [value, ...flattenJsonLd(graph)] : [value];
	}
	return [];
}

function jsonLdScore(record: Record<string, unknown>): number {
	const type = structuredType(record);
	const typed = Boolean(record['@type']);
	const articleType = ARTICLE_TYPE_PATTERN.test(type || '');
	if (typed && !articleType) return 0;

	const headline = fieldText(record, ['headline']);
	const articleBody = fieldText(record, ['articleBody']);
	const publishedAt = fieldText(record, ['datePublished']);
	if (!articleType && !articleBody && !(headline && publishedAt)) return 0;

	let score = articleType ? 10 : 0;
	if (headline || fieldText(record, ['name'])) score += 3;
	if (articleBody) score += 5;
	if (publishedAt) score += 2;
	if (fieldText(record, ['description'])) score += 1;
	return score;
}

function readableCandidates(html: string): string[] {
	const candidates = [
		...elementMatches(html, 'article'),
		...elementMatches(html, 'main'),
		...roleMainMatches(html),
		...attributeContainerMatches(html)
	];
	return candidates.length ? candidates : [html];
}

function readabilityScore(fragment: string, text: string): number {
	const paragraphCount = (fragment.match(/<p\b/gi) || []).length;
	const linkText = [...fragment.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
		.map((match) => cleanReadableText(htmlFragmentToText(match[1])))
		.join(' ');
	const linkDensity = text.length ? linkText.length / text.length : 0;
	const punctuationCount = (text.match(/[.!?]/g) || []).length;
	let score = text.length + paragraphCount * 180 + punctuationCount * 25;
	if (/<h1\b/i.test(fragment)) score += 120;
	if (/class=["'][^"']*(article|story|content|body|post|entry)[^"']*["']/i.test(fragment)) score += 120;
	score -= Math.round(linkDensity * 900);
	return score;
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
	return removeAttributeNoiseBlocks(pruned);
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

function elementMatches(html: string, tag: string): string[] {
	return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'))].map((match) => match[0]);
}

function roleMainMatches(html: string): string[] {
	return [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*role=["']main["'][^>]*>[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
}

function attributeContainerMatches(html: string): string[] {
	const articleAttrs = '(?:article|story|content|body|post|entry)';
	return [...html.matchAll(
		new RegExp(
			`<([a-z][\\w:-]*)\\b[^>]*(?:(?:class|id)=["'][^"']*${articleAttrs}[^"']*["'])[^>]*>[\\s\\S]*?<\\/\\1>`,
			'gi'
		)
	)].map((match) => match[0]);
}

function htmlFragmentToText(html: string): string {
	return decodeEntities(
		stripTags(
			html
				.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
				.replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
				.replace(/<br\s*\/?>/gi, '\n')
				.replace(/<\/(p|div|li|h[1-6]|article|section|main|blockquote)>/gi, '\n')
		)
	);
}

function cleanReadableText(value: string): string {
	const seen = new Set<string>();
	return value
		.replace(/\r/g, '\n')
		.split(/\n+/)
		.map((line) => normalizeWhitespace(line))
		.filter((line) => line && !isNoiseLine(line))
		.filter((line) => {
			const key = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.join('\n')
		.trim();
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
	if (/\b(?:copyright|all rights reserved|privacy policy|terms of use|cookie policy)\b/.test(normalized)) return true;
	if (/\b(?:newsletter|download our app|download the app|get breaking news alerts)\b/.test(normalized)) return true;
	if (line.length < 180 && navTokenCount(normalized) >= 5) return true;
	return false;
}

function navTokenCount(normalized: string): number {
	return [
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
		'local',
		'menu',
		'search',
		'subscribe'
	].filter((token) => new RegExp(`\\b${token}\\b`, 'i').test(normalized)).length;
}

function itempropValue(html: string, property: string): string | null {
	const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	for (const match of html.matchAll(new RegExp(`<([a-z][\\w:-]*)\\b([^>]*\\bitemprop=["']${escaped}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`, 'gi'))) {
		const attrs = match[2];
		const attr = attrValue(attrs, 'content') || attrValue(attrs, 'datetime') || attrValue(attrs, 'href') || attrValue(attrs, 'src');
		const value = attr || cleanReadableText(htmlFragmentToText(match[3]));
		if (value) return value;
	}
	for (const match of html.matchAll(new RegExp(`<meta\\b([^>]*\\bitemprop=["']${escaped}["'][^>]*)>`, 'gi'))) {
		const value = attrValue(match[1], 'content');
		if (value) return value;
	}
	return null;
}

function schemaItemType(html: string): string | null {
	const match = html.match(/itemtype=["'][^"']*schema\.org\/([^"'#/]+)[^"']*["']/i);
	return match?.[1] ?? null;
}

function metaTags(html: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
		const attrs = match[1];
		const key = attrValue(attrs, 'property') || attrValue(attrs, 'name') || attrValue(attrs, 'itemprop');
		const content = attrValue(attrs, 'content');
		if (!key || !content) continue;
		const normalized = key.toLowerCase();
		map.set(normalized, [...(map.get(normalized) || []), decodeEntities(content).trim()]);
	}
	return map;
}

function metaValue(map: Map<string, string[]>, key: string): string | null {
	return map.get(key.toLowerCase())?.find(isNonEmpty) ?? null;
}

function allMetaValues(map: Map<string, string[]>, key: string): string[] {
	return (map.get(key.toLowerCase()) || []).filter(isNonEmpty);
}

function hasAnyMeta(map: Map<string, string[]>, prefix: string): boolean {
	return [...map.keys()].some((key) => key.startsWith(prefix));
}

function linkHref(html: string, rel: string, baseUrl: string): string | null {
	for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
		const attrs = match[1];
		const relValue = attrValue(attrs, 'rel');
		if (!relValue || !relValue.toLowerCase().split(/\s+/).includes(rel)) continue;
		const href = absoluteUrl(attrValue(attrs, 'href'), baseUrl);
		if (href) return href;
	}
	return null;
}

function tagText(body: string, tag: string): string | null {
	const match = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
	return match ? cleanReadableText(htmlFragmentToText(match[1])) : null;
}

function attrValue(attrs: string, name: string): string | null {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i'));
	return match ? decodeEntities((match[1] || match[2] || match[3] || '').trim()) : null;
}

function fieldText(record: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = textFromValue(record[key]);
		if (value) return value;
	}
	return null;
}

function textFromValue(value: unknown): string | null {
	if (typeof value === 'string') return normalizeWhitespace(decodeEntities(value));
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const text = textFromValue(item);
			if (text) return text;
		}
	}
	if (isRecord(value)) return textFromValue(value.name ?? value.headline ?? value.text ?? value['@id'] ?? value.url);
	return null;
}

function authorsFromValue(value: unknown): string[] {
	if (Array.isArray(value)) return uniqueStrings(value.flatMap(authorsFromValue));
	const text = textFromValue(value);
	return text ? [text] : [];
}

function imageFromValue(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return imageFromValue(value[0]);
	if (isRecord(value)) return textFromValue(value.url ?? value.contentUrl ?? value['@id']);
	return null;
}

function keywordsFromValue(value: unknown): string[] {
	if (Array.isArray(value)) return uniqueStrings(value.flatMap(keywordsFromValue));
	if (typeof value !== 'string') return [];
	return uniqueStrings(value.split(/[,;|]/).map((item) => normalizeWhitespace(item)));
}

function mainEntityUrl(record: Record<string, unknown>): string | null {
	const value = record.mainEntityOfPage;
	if (typeof value === 'string') return value;
	if (isRecord(value)) return textFromValue(value['@id'] ?? value.url);
	return null;
}

function structuredType(record: Record<string, unknown>): string | null {
	const type = record['@type'];
	const raw = Array.isArray(type)
		? type.find((item): item is string => typeof item === 'string' && ARTICLE_TYPE_PATTERN.test(item)) ||
			type.find((item): item is string => typeof item === 'string')
		: type;
	if (typeof raw !== 'string') return null;
	return raw.split(/[\/#]/).filter(Boolean).pop() || raw;
}

function hasMetadata(value: Partial<ArticleMetadata>): boolean {
	return Boolean(
		value.title ||
			value.description ||
			value.canonicalUrl ||
			value.publishedAt ||
			value.updatedAt ||
			value.structuredType ||
			value.body ||
			value.image ||
			value.authors?.length ||
			value.keywords?.length
	);
}

function emptyMetadata(): Partial<ArticleMetadata> & { authors: string[]; keywords: string[] } {
	return { authors: [], keywords: [] };
}

function isUsableArticleText(text: string): boolean {
	return text.length >= MIN_ARTICLE_TEXT_CHARS || text.split(/\s+/).filter(Boolean).length >= MIN_ARTICLE_WORDS;
}

function summarizeArticleText(text: string, maxLength = 360): string {
	const sentence = text.split(/(?<=[.!?])\s+/).find((candidate) => candidate.length >= 40) || text;
	return sentence.slice(0, maxLength).trim();
}

function absoluteUrl(value: string | null, baseUrl: string): string | null {
	if (!value) return null;
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return null;
	}
}

function dateText(value: string | null): string | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) return value;
	return new Date(timestamp).toISOString();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const text = normalizeWhitespace(value || '');
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(text);
	}
	return result;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmpty(value: string | null | undefined): value is string {
	return Boolean(value?.trim());
}
