export interface CitationRecord {
	marker: number;
	factId: string;
	claim: string;
	sourceTitle: string;
	sourceName: string;
	sourceUrl: string;
	archiveUrl: string;
	contentHash?: string | null;
	eventId?: string | null;
}

export type DraftCitationSegment =
	| { kind: 'text'; text: string }
	| { kind: 'citation'; marker: number; label: string; citation: CitationRecord };

export interface DraftReviewPayload {
	markdown: string;
	headline: string | null;
	wordCount: number | null;
	targetWordCount: number | null;
	citations: CitationRecord[];
}

export function archiveFallbackUrl(sourceUrl: string, snapshotUrl?: string | null): string {
	const snapshot = safeHttpUrl(snapshotUrl);
	if (snapshot) return snapshot;
	const source = safeHttpUrl(sourceUrl);
	if (!source) return 'https://web.archive.org/';
	return `https://web.archive.org/web/*/${source}`;
}

export function segmentDraftWithCitations(text: string, citations: CitationRecord[]): DraftCitationSegment[] {
	const citationsByMarker = new Map(citations.map((citation) => [citation.marker, citation]));
	const segments: DraftCitationSegment[] = [];
	const markerPattern = /\[(\d{1,3})\]/g;
	let index = 0;
	for (const match of text.matchAll(markerPattern)) {
		const start = match.index ?? 0;
		const label = match[0];
		const marker = Number(match[1]);
		const citation = citationsByMarker.get(marker);
		if (!citation) continue;
		if (start > index) segments.push({ kind: 'text', text: text.slice(index, start) });
		segments.push({ kind: 'citation', marker, label, citation });
		index = start + label.length;
	}
	if (index < text.length) segments.push({ kind: 'text', text: text.slice(index) });
	return segments.length > 0 ? segments : [{ kind: 'text', text }];
}

export function draftReviewPayloadFromValue(value: unknown): DraftReviewPayload | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const markdown = stringValue(raw.draft_markdown) || stringValue(raw.draftMarkdown) || stringValue(raw.markdown);
	if (!markdown) return null;
	const citations = arrayValue(raw.citations).flatMap((citation) => {
		const record = citationRecordFromValue(citation);
		return record ? [record] : [];
	});
	return {
		markdown,
		headline: stringValue(raw.headline),
		wordCount: numberValue(raw.word_count) ?? numberValue(raw.wordCount),
		targetWordCount: numberValue(raw.target_word_count) ?? numberValue(raw.targetWordCount),
		citations
	};
}

function citationRecordFromValue(value: unknown): CitationRecord | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const marker = numberValue(raw.marker);
	const sourceUrl = stringValue(raw.source_url) || stringValue(raw.sourceUrl);
	if (!marker || !sourceUrl) return null;
	const snapshot =
		stringValue(raw.archive_snapshot_url) ||
		stringValue(raw.archiveSnapshotUrl) ||
		stringValue(raw.archive_url) ||
		stringValue(raw.archiveUrl) ||
		stringValue(raw.snapshot_url) ||
		stringValue(raw.snapshotUrl);
	return {
		marker,
		factId: stringValue(raw.fact_id) || stringValue(raw.factId) || `citation-${marker}`,
		claim: stringValue(raw.claim) || stringValue(raw.text) || '',
		sourceTitle: stringValue(raw.source_title) || stringValue(raw.sourceTitle) || stringValue(raw.title) || sourceUrl,
		sourceName:
			stringValue(raw.source_name) ||
			stringValue(raw.sourceName) ||
			stringValue(raw.name) ||
			stringValue(raw.source_title) ||
			stringValue(raw.sourceTitle) ||
			sourceUrl,
		sourceUrl,
		archiveUrl: archiveFallbackUrl(sourceUrl, snapshot),
		contentHash: stringValue(raw.content_hash) || stringValue(raw.contentHash),
		eventId: stringValue(raw.event_id) || stringValue(raw.eventId)
	};
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function safeHttpUrl(value?: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}
