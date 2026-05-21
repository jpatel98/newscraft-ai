import { assessSourceQuality, type SourceQualityAssessment } from '../util/source-quality.js';

type EvidenceSourceKind = 'official' | 'media_report' | 'internal' | 'primary' | 'unknown';

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
		source_kind: sourceKind
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
		const key = `${item.source_url}\n${item.title}`.toLowerCase();
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

function classifyEvidenceSource(sourceName: string, sourceUrl: string): EvidenceSourceKind {
	const haystack = `${sourceName} ${sourceUrl}`.toLowerCase();
	if (haystack.startsWith('newsroom://') || haystack.includes('mission output')) return 'internal';
	if (/\b(police|sheriff|court|city of|government|ministry|department|agency|official)\b/.test(haystack)) {
		return 'official';
	}
	if (/\.(gov|gc\.ca|mil)\b/.test(haystack) || haystack.includes('.gov/') || haystack.includes('canada.ca')) {
		return 'official';
	}
	if (/\b(rss|feed|release|records|filing|pdf)\b/.test(haystack)) return 'primary';
	if (/\b(news|times|star|globe|cbc|ctv|apnews|reuters|guardian|bbc|outlet|media)\b/.test(haystack)) {
		return 'media_report';
	}
	return 'unknown';
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
