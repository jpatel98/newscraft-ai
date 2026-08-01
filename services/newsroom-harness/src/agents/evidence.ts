import { assessSourceQuality, type SourceQualityAssessment } from '../util/source-quality.js';
import { createHash } from 'node:crypto';
import type { ResearchEvidenceStatus } from '@newscraft/shared';
import type { NewsroomTemporalContext } from './time-context.js';

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

export type EvidenceReadability = 'readable' | 'partial' | 'blocked';
export type EvidencePageRole =
	| 'article'
	| 'official_live'
	| 'hub'
	| 'document'
	| 'background'
	| 'event_listing'
	| 'traffic_aggregator'
	| 'homepage'
	| 'category'
	| 'search'
	| 'forum'
	| 'social';
export type EvidenceTemporalScope = 'primary' | 'fallback' | 'background' | 'discovery';

export interface EvidenceRanking {
	score: number;
	eligible: boolean;
	hard_reject_reason?: 'wrong_subject' | 'wrong_entity' | 'wrong_location' | 'wrong_time' | 'invalid' | 'unsafe' | 'unsupported';
	factors: {
		relevance: number;
		freshness: number;
		source_quality: number;
		directness: number;
		readability: number;
		conversation_fit: number;
	};
	notes: string[];
}

export interface EvidenceObject {
	evidence_id?: string;
	canonical_url: string;
	source_name: string;
	publisher?: string | null;
	source_url: string;
	accessed_at: string;
	tool_used: string;
	title: string;
	published_at: string | null;
	updated_at?: string | null;
	extracted_text: string;
	summary: string;
	confidence: number;
	limitations: string[];
	source_kind?: EvidenceSourceKind;
	citation_number?: number;
	document_page?: number;
	topic?: string | null;
	entities?: string[];
	location?: string | null;
	desk?: string | null;
	categories?: string[];
	event_at?: string | null;
	source_authority?: number;
	readability?: EvidenceReadability;
	supporting_excerpt?: string;
	provenance?: {
		url: string;
		tool: string;
		source_kind: EvidenceSourceKind;
	};
	uncertainty?: string[];
	page_role?: EvidencePageRole;
	temporal_scope?: EvidenceTemporalScope;
	ledger_status: ResearchEvidenceStatus;
	rejection_reason?: string;
}

export interface EvidenceInput {
	evidence_id?: string | null;
	canonical_url?: string | null;
	source_name?: string | null;
	publisher?: string | null;
	source_url?: string | null;
	accessed_at?: string | null;
	tool_used?: string | null;
	title?: string | null;
	published_at?: string | null;
	updated_at?: string | null;
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
	topic?: string | null;
	entities?: string[] | null;
	location?: string | null;
	desk?: string | null;
	categories?: string[] | null;
	event_at?: string | null;
	source_authority?: number | string | null;
	readability?: EvidenceReadability | null;
	supporting_excerpt?: string | null;
	uncertainty?: string[] | string | null;
	page_role?: EvidencePageRole | null;
	temporal_scope?: EvidenceTemporalScope | null;
	ledger_status?: ResearchEvidenceStatus | null;
	rejection_reason?: string | null;
}

export function normalizeEvidence(input: EvidenceInput, defaults: Partial<EvidenceObject> = {}): EvidenceObject {
	const sourceUrl = nonEmpty(input.source_url) || nonEmpty(input.url) || defaults.source_url || 'about:blank';
	const canonicalUrl = nonEmpty(input.canonical_url) || defaults.canonical_url || canonicalEvidenceUrl(sourceUrl);
	const title = nonEmpty(input.title) || defaults.title || sourceNameFromUrl(sourceUrl);
	const text = nonEmpty(input.extracted_text) || nonEmpty(input.contentText) || nonEmpty(input.text) || '';
	const summary = nonEmpty(input.summary) || nonEmpty(input.snippet) || summarizeEvidenceText(text || title);
	const sourceName =
		nonEmpty(input.source_name) || defaults.source_name || sourceNameFromUrl(sourceUrl) || 'Unknown source';
	const accessedAt = nonEmpty(input.accessed_at) || nonEmpty(input.fetchedAt) || defaults.accessed_at || nowIso();
	const limitations = normalizeLimitations(input.limitations ?? defaults.limitations);
	const sourceKind = input.source_kind || defaults.source_kind || classifyEvidenceSource(sourceName, sourceUrl);
	const readability =
		input.readability ||
		defaults.readability ||
		readabilityFor(text || summary, limitations);
	const toolUsed = nonEmpty(input.tool_used) || defaults.tool_used || 'unknown_tool';
	const supportingExcerpt =
		nonEmpty(input.supporting_excerpt) ||
		defaults.supporting_excerpt ||
		summarizeEvidenceText(text || summary || title, 520);

	const pageRole = input.page_role || defaults.page_role || classifyEvidencePageRole(sourceUrl, title, sourceKind);
	const categories = normalizeStringList(input.categories ?? defaults.categories);
	const inferredCategories = categories.length ? categories : inferEvidenceCategories(`${title} ${text} ${sourceUrl}`);
	const ledgerStatus = input.ledger_status || defaults.ledger_status || 'discovery';
	return {
		evidence_id:
			nonEmpty(input.evidence_id) ||
			defaults.evidence_id ||
			stableEvidenceId(sourceUrl, title, nonEmpty(input.published_at) || defaults.published_at || null),
		canonical_url: canonicalUrl,
		source_name: sourceName,
		publisher: nonEmpty(input.publisher) || defaults.publisher || sourceName,
		source_url: sourceUrl,
		accessed_at: accessedAt,
		tool_used: toolUsed,
		title,
		published_at: nonEmpty(input.published_at) || defaults.published_at || null,
		updated_at: nonEmpty(input.updated_at) || defaults.updated_at || null,
		extracted_text: text,
		summary,
		confidence: normalizeConfidence(input.confidence ?? defaults.confidence ?? 0.5),
		limitations,
		source_kind: sourceKind,
		citation_number: positiveInteger(input.citation_number ?? defaults.citation_number),
		document_page: positiveInteger(input.document_page ?? defaults.document_page),
		topic: nonEmpty(input.topic) || defaults.topic || null,
		entities: normalizeStringList(input.entities ?? defaults.entities),
		location: nonEmpty(input.location) || defaults.location || null,
		desk: nonEmpty(input.desk) || defaults.desk || inferredCategories[0] || null,
		categories: inferredCategories,
		event_at: nonEmpty(input.event_at) || defaults.event_at || null,
		source_authority: normalizeConfidence(
			input.source_authority ?? defaults.source_authority ?? sourceAuthorityFor(sourceKind)
		),
		readability,
		supporting_excerpt: supportingExcerpt,
		provenance: {
			url: sourceUrl,
			tool: toolUsed,
			source_kind: sourceKind
		},
		uncertainty: normalizeLimitations(input.uncertainty ?? defaults.uncertainty ?? limitations),
		page_role: pageRole,
		temporal_scope: input.temporal_scope || defaults.temporal_scope,
		ledger_status: ledgerStatus,
		...(input.rejection_reason || defaults.rejection_reason
			? { rejection_reason: nonEmpty(input.rejection_reason) || defaults.rejection_reason }
			: {})
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
		const key = item.canonical_url || canonicalEvidenceUrl(item.source_url);
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(item);
	}
	return deduped;
}

export function preparePublishableEvidence(
	evidence: EvidenceObject[],
	temporal: NewsroomTemporalContext,
	currentRequest: boolean
): { accepted: EvidenceObject[]; excluded: EvidenceObject[] } {
	const accepted: EvidenceObject[] = [];
	const excluded: EvidenceObject[] = [];
	for (const raw of dedupeEvidence(evidence)) {
		const hasCitationLinkedExcerpt = hasMeaningfulCitationExcerpt(raw);
		const item = { ...raw, citation_number: undefined, ledger_status: 'discovery' as ResearchEvidenceStatus };
		if (item.source_url.startsWith('newsroom://')) {
			item.temporal_scope = 'primary';
			item.ledger_status = 'accepted';
			accepted.push(item);
			continue;
		}
		const role = item.page_role || classifyEvidencePageRole(item.source_url, item.title, item.source_kind);
		item.page_role = role;
		if (!currentRequest) {
			item.temporal_scope = 'primary';
			item.ledger_status = 'accepted';
			accepted.push(item);
			continue;
		}
		if (role === 'hub' || item.source_kind === 'social_post') {
			item.temporal_scope = 'discovery';
			item.ledger_status = 'rejected';
			item.rejection_reason = role === 'hub' ? 'hub or landing page is discovery-only' : 'social source is excluded';
			excluded.push(item);
			continue;
		}
		const rawTimestamp = item.event_at || item.updated_at || item.published_at || '';
		const dateOnlyScope = /^\d{4}-\d{2}-\d{2}$/.test(rawTimestamp)
			? temporalScopeForLocalDate(rawTimestamp, temporal)
			: null;
		const timestamp = Date.parse(rawTimestamp);
		const officialLive = role === 'official_live' && (item.source_kind === 'official' || item.source_kind === 'primary');
		if (!Number.isFinite(timestamp)) {
			if (officialLive) {
				item.temporal_scope = 'primary';
				item.ledger_status = 'accepted';
				accepted.push(item);
			} else if (
				role === 'article' &&
				isUsableEvidence(item) &&
				hasCitationLinkedExcerpt
			) {
				item.temporal_scope = 'background';
				item.ledger_status = 'accepted';
				item.limitations = [...new Set([
					...item.limitations,
					'Publication or update time is unknown; do not present this source as confirmed within the requested freshness window.'
				])];
				item.uncertainty = [...new Set([...(item.uncertainty || []), 'publication time unknown'])];
				accepted.push(item);
			} else {
				item.temporal_scope = 'background';
				item.ledger_status = 'rejected';
					item.rejection_reason = 'publication or event time is unknown';
					excluded.push(item);
			}
			continue;
		}
		if (dateOnlyScope === 'primary' || dateOnlyScope === 'fallback') {
			item.temporal_scope = dateOnlyScope;
			item.ledger_status = 'accepted';
			accepted.push(item);
			continue;
		}
		if (dateOnlyScope === 'background') {
			item.temporal_scope = 'background';
			item.ledger_status = 'rejected';
			item.rejection_reason = 'publication or event date is outside the request window';
			excluded.push(item);
			continue;
		}
		const windowEndWithClockSkew = Date.parse(temporal.windowEnd) + 5 * 60 * 1000;
		if (timestamp >= Date.parse(temporal.windowStart) && timestamp <= windowEndWithClockSkew) {
			item.temporal_scope = 'primary';
			item.ledger_status = 'accepted';
			accepted.push(item);
			continue;
		}
		if (timestamp >= Date.parse(temporal.fallbackWindowStart) && timestamp <= windowEndWithClockSkew) {
			item.temporal_scope = 'fallback';
			item.ledger_status = 'accepted';
			accepted.push(item);
			continue;
		}
		item.temporal_scope = 'background';
		item.ledger_status = 'rejected';
		item.rejection_reason = 'publication or event time is outside the request window';
		excluded.push(item);
	}
	accepted.sort((left, right) => {
		const scope = scopeOrder(left.temporal_scope) - scopeOrder(right.temporal_scope);
		if (scope) return scope;
		const date = (Date.parse(right.event_at || right.published_at || '') || 0) - (Date.parse(left.event_at || left.published_at || '') || 0);
		if (date) return date;
		return canonicalEvidenceUrl(left.source_url).localeCompare(canonicalEvidenceUrl(right.source_url));
	});
	const storyKeys = new Set<string>();
	const storyDeduped = accepted.filter((item) => {
		const key = storySimilarityKey(item);
		if (!key || !storyKeys.has(key)) {
			if (key) storyKeys.add(key);
			return true;
		}
		return false;
	});
	return {
		accepted: storyDeduped.map((item, index) => ({ ...item, citation_number: index + 1 })),
		excluded
	};
}

function hasMeaningfulCitationExcerpt(item: EvidenceObject): boolean {
	const excerpt = item.supporting_excerpt?.replace(/\s+/g, ' ').trim() || '';
	if (!item.citation_number || excerpt.length < 40) return false;
	if (/^No source excerpt was returned\b/i.test(excerpt)) return false;
	const normalizedExcerpt = excerpt.toLowerCase();
	return normalizedExcerpt !== item.title.trim().toLowerCase() && normalizedExcerpt !== item.source_url.trim().toLowerCase();
}

export function classifyEvidencePageRole(
	sourceUrl: string,
	title: string,
	sourceKind?: EvidenceSourceKind
): EvidencePageRole {
	let path = '';
	try { path = new URL(sourceUrl).pathname.toLowerCase().replace(/\/+$/, ''); } catch { return 'background'; }
	const text = `${path} ${title}`.toLowerCase();
	if (/\.(?:pdf|docx?|xlsx?)$/.test(path) || /\b(?:pdf|report|agenda|minutes|document)\b/.test(title.toLowerCase())) return 'document';
	if ((sourceKind === 'official' || sourceKind === 'primary') && /\b(?:live|status|alert|advisory|schedule|release|statement|bulletin)\b/.test(text)) return 'official_live';
	if (/(?:event|calendar|whatson|whats-on|things-to-do)/.test(path) || /\b(?:event listing|calendar listing)\b/i.test(title)) return 'event_listing';
	if (/(?:traffic|commute|roadconditions|511)/.test(path) || /\btraffic aggregator\b/i.test(title)) return 'traffic_aggregator';
	if (/(?:forum|community)/.test(path) || /\bforum\b/i.test(title)) return 'forum';
	if (/(?:search|tag|category|section)/.test(path)) return /search/.test(path) ? 'search' : 'category';
	if (sourceKind === 'social_post' || /\b(?:social|reddit)\b/i.test(title)) return sourceKind === 'social_post' ? 'social' : 'forum';
	if (!path || /^\/(?:news|toronto|canada|world|local|latest|search|video|videos|watch|listen|player)?$/.test(path) || /\b(?:homepage|section|latest news|player|video hub|search results)\b/.test(title.toLowerCase())) return 'hub';
	if (sourceKind === 'official' || sourceKind === 'primary') return 'official_live';
	if (sourceKind === 'news_report' || sourceKind === 'media_report') return 'article';
	if (looksLikeDirectArticlePath(path)) return 'article';
	return 'background';
}

function looksLikeDirectArticlePath(path: string): boolean {
	const segments = path.split('/').filter(Boolean);
	if (!segments.length) return false;
	const finalSegment = segments.at(-1) || '';
	if (/^20\d{2}$/.test(finalSegment) || /^(?:index|default|home|latest|news|local|world|canada|toronto)$/.test(finalSegment)) return false;
	if (/\/20\d{2}\/(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\//.test(`${path}/`)) return true;
	if (segments.length >= 2 && /(?:^|\/)(?:article|articles|story|stories|news|local)\//.test(path)) return true;
	return finalSegment.split(/[-_]/).filter((part) => part.length > 1).length >= 4;
}

function stableEvidenceId(url: string, title: string, publishedAt: string | null): string {
	return `ev_${createHash('sha256').update(`${canonicalEvidenceUrl(url)}\n${title.trim().toLowerCase()}\n${publishedAt || ''}`).digest('hex').slice(0, 16)}`;
}

export function canonicalEvidenceUrl(value: string): string {
	try {
		const url = new URL(value);
		url.hash = '';
		for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
		return url.toString().replace(/\/$/, '').toLowerCase();
	} catch { return value.trim().toLowerCase(); }
}

function storySimilarityKey(item: EvidenceObject): string {
	return item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function scopeOrder(scope: EvidenceTemporalScope | undefined): number {
	return scope === 'primary' ? 0 : scope === 'fallback' ? 1 : 2;
}

function temporalScopeForLocalDate(
	date: string,
	temporal: NewsroomTemporalContext
): Extract<EvidenceTemporalScope, 'primary' | 'fallback' | 'background'> {
	if (date === temporal.localDate) return 'primary';
	const fallbackDate = new Intl.DateTimeFormat('en-CA', {
		timeZone: temporal.timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	})
		.formatToParts(new Date(temporal.fallbackWindowStart))
		.reduce<Record<string, string>>((parts, part) => {
			if (part.type === 'year' || part.type === 'month' || part.type === 'day') parts[part.type] = part.value;
			return parts;
		}, {});
	const fallbackLocalDate = `${fallbackDate.year}-${fallbackDate.month}-${fallbackDate.day}`;
	return date >= fallbackLocalDate && date <= temporal.localDate ? 'fallback' : 'background';
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
		/(^|\.)go\.jp$/.test(host) ||
		/(^|\.)(gc\.ca|canada\.ca|ontario\.ca|quebec\.ca|toronto\.ca)$/.test(host) ||
		/(^|\.)(elections\.ca|bankofcanada\.ca|rcmp-grc\.gc\.ca|rcmp\.ca|tps\.ca|ttc\.ca)$/.test(host)
	);
}

function isNewsSource(host: string, sourceName: string): boolean {
	if (
		/(^|\.)(reuters\.com|apnews\.com|cbc\.ca|ctvnews\.ca|globalnews\.ca|cp24\.com|citynews\.ca|thestar\.com|theglobeandmail\.com|bbc\.(com|co\.uk)|theguardian\.com|aljazeera\.com|cnn\.com|nytimes\.com|washingtonpost\.com|espn\.com|sportsnet\.ca|tsn\.ca|theathletic\.com)$/.test(
			host
		)
	) {
		return true;
	}
	return /\b(reuters|associated press|ap news|cbc news|ctv news|global news|cp24|citynews|toronto star|globe and mail|bbc news|guardian|news outlet|media report)\b/.test(
		sourceName
	);
}

function isPrimarySource(host: string, path: string, sourceName: string): boolean {
	if (/(^|\.)(fifa\.com|who\.int|un\.org|sec\.gov|hrw\.org|forensic-architecture\.org)$/.test(host)) return true;
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

function normalizeStringList(value: string[] | null | undefined): string[] {
	if (!value) return [];
	return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean))).slice(0, 12);
}

export function inferEvidenceCategories(value: string): string[] {
	const categories = [
		'politics',
		'government',
		'business',
		'economy',
		'health',
		'public safety',
		'crime',
		'courts',
		'transit',
		'traffic',
		'weather',
		'education',
		'housing',
		'environment',
		'community',
		'culture',
		'entertainment',
		'technology',
		'sports',
		'events'
	];
	const normalized = value.toLowerCase();
	return categories.filter((category) => new RegExp(`\\b${category.replace(/\s+/g, '\\s+')}\\b`, 'i').test(normalized));
}

function sourceAuthorityFor(kind: EvidenceSourceKind): number {
	if (kind === 'official' || kind === 'primary' || kind === 'user_document') return 0.95;
	if (kind === 'news_report' || kind === 'media_report') return 0.8;
	if (kind === 'commercial') return 0.55;
	if (kind === 'social_post') return 0.4;
	if (kind === 'internal') return 0.7;
	return 0.5;
}

function readabilityFor(text: string, limitations: string[]): EvidenceReadability {
	if (limitations.some((item) => /login|captcha|paywall|blocked|access denied/i.test(item))) return 'blocked';
	const length = text.replace(/\s+/g, ' ').trim().length;
	if (length >= 80) return 'readable';
	return length > 0 ? 'partial' : 'blocked';
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
