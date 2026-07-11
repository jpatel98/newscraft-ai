import { assessSourceQuality, type SourceQualityAssessment } from '../util/source-quality.js';

export type JournalistSourceKind =
	| 'official'
	| 'primary'
	| 'news_report'
	| 'social_post'
	| 'user_document'
	| 'commercial'
	| 'unknown';

// Keep the two legacy values while the rest of the harness migrates to the
// journalist-facing source contract. Web evidence is always classified with
// JournalistSourceKind.
export type EvidenceSourceKind = JournalistSourceKind | 'internal' | 'media_report';

export interface EvidenceObject {
	source_name: string;
	source_url: string;
	accessed_at: string;
	tool_used: string;
	title: string;
	published_at: string | null;
	extracted_text: string;
	summary: string;
	confidence: number;
	limitations: string[];
	source_kind?: EvidenceSourceKind;
	citation_number?: number;
	document_page?: number;
}

export interface EvidenceInput {
	source_name?: string | null;
	source_url?: string | null;
	accessed_at?: string | null;
	tool_used?: string | null;
	title?: string | null;
	published_at?: string | null;
	extracted_text?: string | null;
	contentText?: string | null;
	text?: string | null;
	summary?: string | null;
	snippet?: string | null;
	confidence?: number | string | null;
	limitations?: string[] | string | null;
	source_kind?: EvidenceSourceKind | null;
	citation_number?: number | string | null;
	document_page?: number | string | null;
	url?: string | null;
	fetchedAt?: string | null;
}

export function normalizeEvidence(input: EvidenceInput, defaults: Partial<EvidenceObject> = {}): EvidenceObject {
	const sourceUrl = nonEmpty(input.source_url) || nonEmpty(input.url) || defaults.source_url || 'about:blank';
	const title = nonEmpty(input.title) || defaults.title || sourceNameFromUrl(sourceUrl);
	const text = nonEmpty(input.extracted_text) || nonEmpty(input.contentText) || nonEmpty(input.text) || '';
	const summary = nonEmpty(input.summary) || nonEmpty(input.snippet) || summarizeEvidenceText(text || title);
	const sourceName =
		nonEmpty(input.source_name) || defaults.source_name || sourceNameFromUrl(sourceUrl) || 'Unknown source';
	const accessedAt = nonEmpty(input.accessed_at) || nonEmpty(input.fetchedAt) || defaults.accessed_at || nowIso();
	const limitations = normalizeLimitations(input.limitations ?? defaults.limitations);
	const sourceKind = input.source_kind || defaults.source_kind || classifyEvidenceSource(sourceName, sourceUrl);

	return {
		source_name: sourceName,
		source_url: sourceUrl,
		accessed_at: accessedAt,
		tool_used: nonEmpty(input.tool_used) || defaults.tool_used || 'unknown_tool',
		title,
		published_at: nonEmpty(input.published_at) || defaults.published_at || null,
		extracted_text: text,
		summary,
		confidence: normalizeConfidence(input.confidence ?? defaults.confidence ?? 0.5),
		limitations,
		source_kind: sourceKind,
		citation_number: positiveInteger(input.citation_number ?? defaults.citation_number),
		document_page: positiveInteger(input.document_page ?? defaults.document_page)
	};
}

export function normalizeToolEvidence(
	output: unknown,
	toolUsed: string,
	defaults: Partial<EvidenceObject> = {}
): EvidenceObject[] {
	const value = output as {
		evidence?: EvidenceInput[];
		items?: EvidenceInput[];
		sources?: EvidenceInput[];
		source?: EvidenceInput;
	};
	const candidates = [
		...(Array.isArray(value?.evidence) ? value.evidence : []),
		...(Array.isArray(value?.items) ? value.items : []),
		...(Array.isArray(value?.sources) ? value.sources : []),
		...(value?.source ? [value.source] : [])
	];

	return dedupeEvidence(
		candidates.map((candidate) =>
			normalizeEvidence(candidate, {
				...defaults,
				tool_used: toolUsed
			})
		)
	);
}

export function dedupeEvidence(evidence: EvidenceObject[]): EvidenceObject[] {
	const seen = new Set<string>();
	const deduped: EvidenceObject[] = [];
	for (const item of evidence) {
		const citationKey = item.citation_number ? `\n${item.citation_number}` : '';
		const key = `${item.source_url}\n${item.title}${citationKey}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

export function assessEvidenceQuality(evidence: EvidenceObject): SourceQualityAssessment {
	return assessSourceQuality({
		title: evidence.title,
		text: evidence.extracted_text,
		summary: evidence.summary,
		limitations: evidence.limitations,
		confidence: evidence.confidence
	});
}

export function isUsableEvidence(evidence: EvidenceObject): boolean {
	const quality = assessEvidenceQuality(evidence);
	return quality.usable && Boolean(evidence.extracted_text.trim() || evidence.summary.trim());
}

function summarizeEvidenceText(text: string, maxLength = 320): string {
	const cleaned = text.replace(/\s+/g, ' ').trim();
	if (!cleaned) return '';
	const sentence = cleaned.split(/(?<=[.!?])\s+/).find((candidate) => candidate.length >= 40) || cleaned;
	return sentence.slice(0, maxLength).trim();
}

export function classifyEvidenceSource(sourceName: string, sourceUrl: string): EvidenceSourceKind {
	const normalizedName = sourceName.toLowerCase();
	const normalizedUrl = sourceUrl.toLowerCase();
	if (normalizedUrl.startsWith('newsroom://') || normalizedName.includes('research update')) return 'internal';
	if (normalizedUrl.startsWith('document://') || normalizedUrl.startsWith('attachment://')) return 'user_document';

	const parsed = safeUrl(sourceUrl);
	const host = parsed?.hostname.replace(/^www\./, '').toLowerCase() || '';
	const path = parsed?.pathname.toLowerCase() || '';

	if (isSocialHost(host)) return 'social_post';
	if (isOfficialSource(host)) return 'official';
	if (isNewsSource(host, normalizedName)) return 'news_report';
	if (isCommercialSource(host, path, normalizedName)) return 'commercial';
	if (isPrimarySource(host, path, normalizedName)) return 'primary';
	return 'unknown';
}

function safeUrl(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

function isSocialHost(host: string): boolean {
	return (
		/(^|\.)(x|twitter|facebook|instagram|tiktok|threads|reddit|youtube)\.com$/.test(host) ||
		/(^|\.)bsky\.app$/.test(host) ||
		/(^|\.)mastodon\.social$/.test(host)
	);
}

function isOfficialSource(host: string): boolean {
	return (
		/(^|\.)(gov|mil)(\.[a-z]{2})?$/.test(host) ||
		/(^|\.)(gc\.ca|canada\.ca|ontario\.ca|quebec\.ca|toronto\.ca)$/.test(host) ||
		/(^|\.)(elections\.ca|bankofcanada\.ca|rcmp-grc\.gc\.ca|tps\.ca)$/.test(host)
	);
}

function isNewsSource(host: string, sourceName: string): boolean {
	if (
		/(^|\.)(reuters\.com|apnews\.com|cbc\.ca|ctvnews\.ca|globalnews\.ca|citynews\.ca|thestar\.com|theglobeandmail\.com|bbc\.(com|co\.uk)|theguardian\.com|cnn\.com|nytimes\.com|washingtonpost\.com|espn\.com|sportsnet\.ca|tsn\.ca|theathletic\.com)$/.test(
			host
		)
	) {
		return true;
	}
	return /\b(reuters|associated press|ap news|cbc news|ctv news|global news|citynews|toronto star|globe and mail|bbc news|guardian|news outlet|media report)\b/.test(
		sourceName
	);
}

function isPrimarySource(host: string, path: string, sourceName: string): boolean {
	if (/(^|\.)(fifa\.com|who\.int|un\.org|sec\.gov)$/.test(host)) return true;
	if (/\.(edu|ac\.[a-z]{2})$/.test(host)) return true;
	const directDocument = /\b(press[-_/ ]?release|newsroom|media[-_/ ]?release|regulatory[-_/ ]?filing|agenda|minutes|transcript|official[-_/ ]?statement)\b/.test(
		path
	);
	if (!directDocument) return false;
	const publisherToken = host.split('.').slice(-2, -1)[0]?.replace(/[^a-z0-9]/g, '') || '';
	return publisherToken.length >= 4 && sourceName.replace(/[^a-z0-9]/g, '').includes(publisherToken);
}

function isCommercialSource(host: string, path: string, sourceName: string): boolean {
	if (
		/(^|\.)(amazon\.[a-z.]+|walmart\.[a-z.]+|ticketmaster\.[a-z.]+|stubhub\.[a-z.]+|eventbrite\.[a-z.]+|expedia\.[a-z.]+|booking\.com|realtor\.[a-z.]+|zillow\.com)$/.test(
			host
		)
	) {
		return true;
	}
	return /\b(shop|store|marketplace|tickets?|pricing|product|sponsored|affiliate)\b/.test(`${path} ${sourceName}`);
}

export function evidenceHasBlockingLimitation(evidence: EvidenceObject[]): boolean {
	return evidence.some((item) =>
		!assessEvidenceQuality(item).usable ||
		item.limitations.some((limitation) => /login|captcha|paywall|blocked|unavailable/i.test(limitation))
	);
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeLimitations(value: string[] | string | null | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) return value.filter(Boolean).map(String);
	return [value].filter(Boolean).map(String);
}

function normalizeConfidence(value: number | string | null | undefined): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return 0.5;
	if (parsed > 1) return Math.max(0, Math.min(1, parsed / 100));
	return Math.max(0, Math.min(1, parsed));
}

function positiveInteger(value: number | string | null | undefined): number | undefined {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

function nonEmpty(value: string | null | undefined): string | null {
	const trimmed = typeof value === 'string' ? value.trim() : '';
	return trimmed || null;
}

function sourceNameFromUrl(value: string): string {
	if (value.startsWith('newsroom://')) return value.replace('newsroom://', '').replace(/[-_/]+/g, ' ');
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value || 'Unknown source';
	}
}
