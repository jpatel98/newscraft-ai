import {
	MAX_DOCUMENTS_PER_UPLOAD,
	MAX_PDF_BYTES,
	PDF_MIME_TYPE
} from './constants';
import { DocumentError } from './errors';
import type { PdfUploadInput } from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function validatePdfUploads(value: unknown): PdfUploadInput[] {
	if (!Array.isArray(value) || value.length < 1) {
		throw new DocumentError(400, 'documents_required', 'Select at least one PDF.');
	}
	if (value.length > MAX_DOCUMENTS_PER_UPLOAD) {
		throw new DocumentError(
			400,
			'too_many_documents',
			`Attach no more than ${MAX_DOCUMENTS_PER_UPLOAD} PDFs at a time.`
		);
	}
	return value.map(validatePdfUpload);
}

export function validatePdfUpload(value: unknown): PdfUploadInput {
	if (!value || typeof value !== 'object') {
		throw new DocumentError(400, 'invalid_document', 'The selected PDF is invalid.');
	}
	const input = value as Record<string, unknown>;
	const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
	const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
	const sizeBytes = typeof input.sizeBytes === 'number' ? input.sizeBytes : Number.NaN;
	const checksumSha256 =
		typeof input.checksumSha256 === 'string' ? input.checksumSha256.trim().toLowerCase() : '';

	if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
		throw new DocumentError(400, 'invalid_filename', 'The PDF filename is invalid.');
	}
	if (mimeType !== PDF_MIME_TYPE || !filename.toLowerCase().endsWith('.pdf')) {
		throw new DocumentError(415, 'pdf_only', 'Only PDF files are supported.');
	}
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
		throw new DocumentError(400, 'invalid_file_size', 'The PDF file size is invalid.');
	}
	if (sizeBytes > MAX_PDF_BYTES) {
		throw new DocumentError(413, 'pdf_too_large', 'PDFs must be 20 MB or smaller.');
	}
	if (!SHA256_RE.test(checksumSha256)) {
		throw new DocumentError(400, 'invalid_checksum', 'The PDF checksum is invalid.');
	}

	return { filename, mimeType: PDF_MIME_TYPE, sizeBytes, checksumSha256 };
}

export function safeStorageFilename(filename: string): string {
	const withoutExtension = filename.replace(/\.pdf$/i, '');
	const base = withoutExtension
		.normalize('NFKD')
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^[._-]+|[._-]+$/g, '')
		.slice(0, 120);
	return `${base || 'document'}.pdf`;
}

export const MAX_SHOW_NAME_LENGTH = 120;
export const MAX_AUDIENCE_LENGTH = 160;
export const MAX_BEATS = 12;
export const MAX_BEAT_LENGTH = 60;
export const MAX_STYLE_NOTES_LENGTH = 1200;
export const MAX_RECENTLY_COVERED = 30;
export const MAX_RECENT_SUBJECT_LENGTH = 160;
const AIR_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface NormalizedNewsroomProfile {
	timezone: string;
	homeMarket: string;
	preferredDomains: string[];
	/** Show-memory fields are present only when the caller supplied them. */
	showName?: string;
	airTimeLocal?: string;
	audience?: string;
	beats?: string[];
	styleNotes?: string;
	recentlyCovered?: Array<{ subject: string; coveredAt: number }>;
}

function singleLine(value: unknown, max: number, code: string, label: string): string {
	if (typeof value !== 'string') {
		throw new DocumentError(400, code, `${label} must be text.`);
	}
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length > max) {
		throw new DocumentError(400, code, `${label} must be ${max} characters or fewer.`);
	}
	return text;
}

function dedupedList(
	value: unknown,
	options: { max: number; itemMax: number; code: string; label: string; plural: string }
): string[] {
	if (!Array.isArray(value)) {
		throw new DocumentError(400, options.code, `${options.plural} must be a list.`);
	}
	const seen = new Set<string>();
	const items: string[] = [];
	for (const raw of value) {
		const item = singleLine(raw, options.itemMax, options.code, options.label);
		if (!item) continue;
		const key = item.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		items.push(item);
	}
	if (items.length > options.max) {
		throw new DocumentError(400, options.code, `Add no more than ${options.max} ${options.plural.toLowerCase()}.`);
	}
	return items;
}

export function normalizeNewsroomProfile(
	input: {
		timezone: unknown;
		homeMarket?: unknown;
		preferredDomains?: unknown;
		showName?: unknown;
		airTimeLocal?: unknown;
		audience?: unknown;
		beats?: unknown;
		styleNotes?: unknown;
		recentlyCovered?: unknown;
	},
	now: number = Date.now(),
	existingCoveredAt: ReadonlyMap<string, number> = new Map()
): NormalizedNewsroomProfile {
	const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : '';
	if (!isIanaTimezone(timezone)) {
		throw new DocumentError(400, 'invalid_timezone', 'Choose a valid newsroom timezone.');
	}
	const homeMarket = typeof input.homeMarket === 'string' ? input.homeMarket.trim() : '';
	if (homeMarket.length > 120) {
		throw new DocumentError(400, 'invalid_home_market', 'Home market must be 120 characters or fewer.');
	}
	const rawDomains = input.preferredDomains ?? [];
	if (!Array.isArray(rawDomains) || rawDomains.length > 20) {
		throw new DocumentError(400, 'invalid_preferred_domains', 'Add no more than 20 preferred domains.');
	}
	const preferredDomains = Array.from(
		new Set(
			rawDomains.map((value) => {
				if (typeof value !== 'string') {
					throw new DocumentError(400, 'invalid_preferred_domains', 'A preferred domain is invalid.');
				}
				const domain = value.trim().toLowerCase().replace(/^www\./, '');
				if (!DOMAIN_RE.test(domain)) {
					throw new DocumentError(400, 'invalid_preferred_domains', 'A preferred domain is invalid.');
				}
				return domain;
			})
		)
	);
	const profile: NormalizedNewsroomProfile = { timezone, homeMarket, preferredDomains };

	if (input.showName !== undefined) {
		profile.showName = singleLine(input.showName, MAX_SHOW_NAME_LENGTH, 'invalid_show_name', 'Show name');
	}
	if (input.airTimeLocal !== undefined) {
		const airTime = typeof input.airTimeLocal === 'string' ? input.airTimeLocal.trim() : null;
		if (airTime === null || (airTime !== '' && !AIR_TIME_RE.test(airTime))) {
			throw new DocumentError(400, 'invalid_air_time', 'Air time must be HH:MM in 24-hour time, or blank.');
		}
		profile.airTimeLocal = airTime;
	}
	if (input.audience !== undefined) {
		profile.audience = singleLine(input.audience, MAX_AUDIENCE_LENGTH, 'invalid_audience', 'Audience');
	}
	if (input.beats !== undefined) {
		profile.beats = dedupedList(input.beats, {
			max: MAX_BEATS,
			itemMax: MAX_BEAT_LENGTH,
			code: 'invalid_beats',
			label: 'A beat',
			plural: 'Beats'
		});
	}
	if (input.styleNotes !== undefined) {
		if (typeof input.styleNotes !== 'string') {
			throw new DocumentError(400, 'invalid_style_notes', 'Style notes must be text.');
		}
		const notes = input.styleNotes.replace(/\r\n?/g, '\n').trim();
		if (notes.length > MAX_STYLE_NOTES_LENGTH) {
			throw new DocumentError(
				400,
				'invalid_style_notes',
				`Style notes must be ${MAX_STYLE_NOTES_LENGTH} characters or fewer.`
			);
		}
		profile.styleNotes = notes;
	}
	if (input.recentlyCovered !== undefined) {
		profile.recentlyCovered = normalizeRecentlyCovered(input.recentlyCovered, now, existingCoveredAt);
	}
	return profile;
}

/**
 * Accepts subject strings or `{ subject, coveredAt }` objects and keeps the
 * first of each subject. A bare string keeps the date already recorded for that
 * subject (keyed by lower-cased subject), otherwise it is stamped with `now`.
 */
export function normalizeRecentlyCovered(
	value: unknown,
	now: number,
	existingCoveredAt: ReadonlyMap<string, number> = new Map()
): Array<{ subject: string; coveredAt: number }> {
	if (!Array.isArray(value)) {
		throw new DocumentError(400, 'invalid_recently_covered', 'Recently covered must be a list.');
	}
	const seen = new Set<string>();
	const entries: Array<{ subject: string; coveredAt: number }> = [];
	for (const raw of value) {
		let subjectValue: unknown = raw;
		let coveredAt: number | undefined;
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			const record = raw as Record<string, unknown>;
			subjectValue = record.subject;
			if (record.coveredAt !== undefined) {
				if (
					typeof record.coveredAt !== 'number' ||
					!Number.isSafeInteger(record.coveredAt) ||
					record.coveredAt <= 0
				) {
					throw new DocumentError(400, 'invalid_recently_covered', 'A covered date is invalid.');
				}
				coveredAt = record.coveredAt;
			}
		}
		const subject = singleLine(
			subjectValue,
			MAX_RECENT_SUBJECT_LENGTH,
			'invalid_recently_covered',
			'A recently covered subject'
		);
		if (!subject) continue;
		const key = subject.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ subject, coveredAt: coveredAt ?? existingCoveredAt.get(key) ?? now });
	}
	if (entries.length > MAX_RECENTLY_COVERED) {
		throw new DocumentError(
			400,
			'invalid_recently_covered',
			`Add no more than ${MAX_RECENTLY_COVERED} recently covered subjects.`
		);
	}
	return entries;
}

function isIanaTimezone(value: string): boolean {
	if (!value) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}
