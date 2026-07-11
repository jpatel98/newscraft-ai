import type { CitationRecord, CitationSourceType } from '@newscraft/shared';
import {
	citationNumbersInText,
	isInspectableCitationRecord,
	resolvedCitationNumbersForAnswer
} from '$lib/utils/tool-metadata';

export type AnswerUseAction =
	| 'producer_brief'
	| 'thirty_second_script'
	| 'interview_questions'
	| 'copy_with_citations';

export type ComposerDocumentState = 'uploading' | 'processing' | 'ready' | 'failed';

export interface ComposerDocumentAttachment {
	/** Stable browser-side id used while an upload is in progress. */
	id: string;
	/** Durable server id, added after the signed upload is accepted. */
	documentId?: string;
	name: string;
	bytes: number;
	state: ComposerDocumentState;
	pageCount?: number;
	error?: string;
}

export interface DocumentUploadControls {
	id: string;
	update: (patch: Partial<ComposerDocumentAttachment>) => void;
}

export const MAX_PDF_ATTACHMENTS = 3;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export const ANSWER_USE_ACTIONS: ReadonlyArray<{ action: AnswerUseAction; label: string }> = [
	{
		action: 'producer_brief',
		label: 'Producer brief'
	},
	{
		action: 'thirty_second_script',
		label: '30-second script'
	},
	{
		action: 'interview_questions',
		label: 'Interview questions'
	},
	{
		action: 'copy_with_citations',
		label: 'Copy with citations'
	}
];

export function mergeCitationRecords(
	...groups: ReadonlyArray<ReadonlyArray<CitationRecord>>
): CitationRecord[] {
	const merged = new Map<string, CitationRecord>();
	for (const citation of groups.flat()) {
		const key = `${citation.citationNumber}\u0000${citation.url}\u0000${citation.documentPage ?? ''}`;
		merged.set(key, citation);
	}
	return Array.from(merged.values()).sort((a, b) => a.citationNumber - b.citationNumber);
}

export function visibleCitationNumbers(markdown: string): number[] {
	return citationNumbersInText(markdown);
}

export function citationResolution(markdown: string, citations: ReadonlyArray<CitationRecord>) {
	const markers = visibleCitationNumbers(markdown);
	const resolved = resolvedCitationNumbersForAnswer(markdown, citations);
	return {
		markers,
		resolved,
		dangling: markers.filter((number) => !resolved.includes(number)),
		allResolved: citations.length > 0 && markers.length > 0 && resolved.length === markers.length
	};
}

export function resolvedCitationRecords(
	markdown: string,
	citations: ReadonlyArray<CitationRecord>
): CitationRecord[] {
	const resolved: CitationRecord[] = [];
	const seen = new Set<number>();
	for (const number of visibleCitationNumbers(markdown)) {
		if (seen.has(number)) continue;
		const matches = citations.filter((citation) => citation.citationNumber === number);
		const records = mergeCitationRecords(matches);
		if (records.length !== 1 || !isInspectableCitationRecord(records[0])) continue;
		seen.add(number);
		resolved.push(records[0]);
	}
	return resolved;
}

export function citationSourceTypeLabel(sourceType: CitationSourceType): string {
	return (
		{
			official: 'Official source',
			primary: 'Primary source',
			news_report: 'News report',
			social_post: 'Social post',
			user_document: 'User document',
			commercial: 'Commercial source',
			unknown: 'Source type unknown'
		} satisfies Record<CitationSourceType, string>
	)[sourceType];
}

export function publicationDateLabel(value: string | null): string {
	if (!value) return 'Date unknown';
	const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	const parsed = dateOnly
		? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
		: new Date(value);
	if (Number.isNaN(parsed.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	}).format(parsed);
}

export function answerExportUrl(
	conversationId: string | null | undefined,
	messageId: string
): string | null {
	if (!conversationId || !messageId || messageId.startsWith('tmp-')) return null;
	return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/export`;
}

export function isPdfFile(file: Pick<File, 'name' | 'type'>): boolean {
	return file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
}

export function pdfSelectionError(
	files: ReadonlyArray<Pick<File, 'name' | 'type' | 'size'>>,
	existingCount: number
): string | null {
	if (files.some((file) => !isPdfFile(file))) return 'Only PDF documents are allowed.';
	if (files.some((file) => file.size > MAX_PDF_BYTES)) {
		return 'Each PDF must be 20 MB or smaller.';
	}
	if (existingCount + files.length > MAX_PDF_ATTACHMENTS) {
		return `You can attach up to ${MAX_PDF_ATTACHMENTS} PDFs per message.`;
	}
	return null;
}

export function documentStateLabel(document: ComposerDocumentAttachment): string {
	if (document.state === 'uploading') return 'Uploading';
	if (document.state === 'processing') return 'Processing';
	if (document.state === 'failed') return document.error || 'Failed';
	if (!document.documentId) return 'Finalizing';
	if (document.pageCount) {
		return `${document.pageCount} page${document.pageCount === 1 ? '' : 's'} ready`;
	}
	return 'Ready';
}
