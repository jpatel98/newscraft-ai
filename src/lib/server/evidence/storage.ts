import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { DOCUMENT_BUCKET } from '$lib/server/documents/constants';
import { DocumentError } from '$lib/server/documents/errors';
import { documentStorageProvider } from '$lib/server/documents/storage';
import { VpsStorageClient, VpsStorageError } from '$lib/server/storage/vps-client';
import { EVIDENCE_CSV_MIME, EVIDENCE_PDF_MIME, MAX_EVIDENCE_CSV_BYTES, MAX_EVIDENCE_PDF_BYTES } from './constants';
import type { EvidenceKind, EvidenceStorage } from './types';

const DEFAULT_CSV_BUCKET = 'newsroom-artifacts';

function unavailable(): DocumentError {
	return new DocumentError(503, 'evidence_storage_unavailable', 'Evidence storage is unavailable right now.');
}

/**
 * Evidence objects live in the private storage gateway. PDFs share the
 * existing PDF-only bucket policy; CSVs use the bucket whose policy already
 * admits text/csv (the artifact bucket by default) under an `evidence/` key
 * prefix that no other producer writes. Keys are opaque ids, never filenames.
 */
export function createVpsEvidenceStorage(options: {
	baseUrl?: string;
	apiKey?: string;
	pdfBucket?: string;
	csvBucket?: string;
	fetchImpl?: typeof fetch;
	allowLoopbackHttp?: boolean;
} = {}): EvidenceStorage {
	const baseUrl = (options.baseUrl ?? env.NEWSCRAFT_STORAGE_BASE_URL ?? '').trim();
	const apiKey = (options.apiKey ?? env.NEWSCRAFT_STORAGE_API_KEY ?? '').trim();
	const buckets: Record<EvidenceKind, string> = {
		pdf: (options.pdfBucket ?? env.NEWSCRAFT_DOCUMENT_STORAGE_BUCKET ?? DOCUMENT_BUCKET).trim(),
		csv: (options.csvBucket ?? env.NEWSCRAFT_EVIDENCE_CSV_BUCKET ?? env.NEWSCRAFT_ARTIFACT_STORAGE_BUCKET ?? DEFAULT_CSV_BUCKET).trim()
	};
	const client = baseUrl && apiKey
		? new VpsStorageClient({ baseUrl, apiKey, fetchImpl: options.fetchImpl, allowLoopbackHttp: options.allowLoopbackHttp ?? dev })
		: null;
	const require = () => {
		if (!client) throw unavailable();
		return client;
	};
	async function verifyCapability() {
		try {
			const [pdf, csv] = await Promise.all([require().verifyPolicy(buckets.pdf), require().verifyPolicy(buckets.csv)]);
			if (pdf.supportsUploadRevocation !== true || csv.supportsUploadRevocation !== true) throw unavailable();
			if (!pdf.private || pdf.maxBytes < MAX_EVIDENCE_PDF_BYTES || !pdf.mimeTypes.includes(EVIDENCE_PDF_MIME)) throw unavailable();
			if (!csv.private || csv.maxBytes < MAX_EVIDENCE_CSV_BYTES || !csv.mimeTypes.includes(EVIDENCE_CSV_MIME)) throw unavailable();
		} catch {
			throw unavailable();
		}
	}
	return {
		bucketFor: (kind) => buckets[kind],
		async createSignedUpload(kind, path, maxBytes, contentType) {
			try {
				await verifyCapability();
				const signed = await require().signUpload({ bucket: buckets[kind], key: path, maxBytes, contentType });
				return { ...signed, contentType };
			} catch {
				throw unavailable();
			}
		},
		async download(kind, path, bucket) {
			try {
				return await require().getObject({ bucket: bucket ?? buckets[kind], key: path });
			} catch (error) {
				if (error instanceof VpsStorageError && error.status === 404) {
					throw new DocumentError(409, 'upload_not_ready', 'The upload has not arrived yet.');
				}
				throw unavailable();
			}
		},
		async createSignedDownload(kind, path, expiresInSeconds, bucket) {
			try {
				return await require().signDownload({ bucket: bucket ?? buckets[kind], key: path, expiresInSeconds });
			} catch {
				throw unavailable();
			}
		},
		async remove(kind, path, bucket) {
			try {
				await require().remove({ bucket: bucket ?? buckets[kind], key: path, revokeUploads: true });
			} catch {
				throw unavailable();
			}
		},
		verifyCapability
	};
}

export function createSupabaseEvidenceStorage(): EvidenceStorage {
	const unsupported = () => new DocumentError(503, 'evidence_gateway_required', 'Project evidence requires the NewsCraft VPS storage gateway with upload revocation. Supabase project evidence is not supported.');
	return {
		bucketFor() {
			throw unsupported();
		},
		async createSignedUpload() {
			throw unsupported();
		},
		async download() {
			throw unsupported();
		},
		async createSignedDownload() {
			throw unsupported();
		},
		async remove() {
			throw unsupported();
		},
		async verifyCapability() {
			throw unsupported();
		}
	};
}

export function createEvidenceStorage(): EvidenceStorage {
	const provider = documentStorageProvider();
	if (provider === 'vps') return createVpsEvidenceStorage();
	if (provider === 'supabase') return createSupabaseEvidenceStorage();
	throw unavailable();
}

