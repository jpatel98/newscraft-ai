import { sha256Hex } from './documents';

export type EvidenceKind = 'pdf' | 'csv';
export type EvidenceState = 'uploading' | 'processing' | 'ready' | 'failed' | 'deleting';

export interface EvidenceDocumentSummary {
	id: string;
	projectId: string;
	kind: EvidenceKind;
	name: string;
	mimeType: string;
	sizeBytes: number;
	state: EvidenceState;
	sha256: string | null;
	pageCount: number | null;
	rowCount: number | null;
	columnCount: number | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

interface UploadIntentResult {
	document: EvidenceDocumentSummary;
	upload: { path: string; token: string; signedUrl: string; contentType: string };
}

export class EvidenceClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EvidenceClientError';
	}
}

export function evidenceKindForFile(file: File): EvidenceKind | null {
	const lower = file.name.toLowerCase();
	if (lower.endsWith('.pdf')) return 'pdf';
	if (lower.endsWith('.csv')) return 'csv';
	return null;
}

/**
 * Intent, direct PUT to the private store, then finalize. The hash the browser
 * sends is a declaration; the server recomputes it from the stored bytes before
 * anything becomes evidence.
 */
export async function uploadProjectEvidence(
	projectId: string,
	file: File,
	options: { fetch?: typeof fetch; onCreated?: (document: EvidenceDocumentSummary) => void; onProcessing?: (document: EvidenceDocumentSummary) => void } = {}
): Promise<EvidenceDocumentSummary> {
	const fetchImpl = options.fetch ?? fetch;
	const kind = evidenceKindForFile(file);
	if (!kind) throw new EvidenceClientError('Only PDF and CSV files are supported.');
	const checksumSha256 = await sha256Hex(file);
	const intentResponse = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/evidence`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ documents: [{ filename: file.name, mimeType: kind === 'pdf' ? 'application/pdf' : file.type || 'text/csv', sizeBytes: file.size, checksumSha256 }] })
	});
	const intentBody = await responseJson<{ documents?: UploadIntentResult[] }>(intentResponse, "Couldn't prepare that file. Try again.");
	const created = intentBody.documents?.[0];
	if (!created?.document?.id || !isSafeSignedUrl(created.upload?.signedUrl)) {
		throw new EvidenceClientError("Couldn't prepare that file. Try again.");
	}
	options.onCreated?.(created.document);
	const destination = new URL(created.upload.signedUrl);
	const gatewayUpload = /\/v1\/upload\/[^/]+$/u.test(destination.pathname);
	let body: BodyInit = file;
	let headers: Record<string, string> = { 'content-type': created.upload.contentType };
	if (!gatewayUpload) {
		const form = new FormData();
		form.append('cacheControl', '3600');
		form.append('', file);
		body = form;
		headers = { 'x-upsert': 'false' };
	}
	const uploadResponse = await fetchImpl(created.upload.signedUrl, { method: 'PUT', headers, body });
	if (!uploadResponse.ok) throw new EvidenceClientError("Couldn't upload that file. Try again.");
	options.onProcessing?.({ ...created.document, state: 'processing' });
	const finalizeResponse = await fetchImpl(
		`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(created.document.id)}/finalize`,
		{ method: 'POST', headers: { accept: 'application/json' } }
	);
	const finalizeBody = await responseJson<{ document?: EvidenceDocumentSummary }>(finalizeResponse, "Couldn't process that file. Try again.");
	if (!finalizeBody.document || finalizeBody.document.state !== 'ready') {
		throw new EvidenceClientError(finalizeBody.document?.error || "Couldn't process that file. Try again.");
	}
	return finalizeBody.document;
}

export async function deleteProjectEvidence(projectId: string, documentId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
	const response = await fetchImpl(`/api/projects/${encodeURIComponent(projectId)}/evidence/${encodeURIComponent(documentId)}`, {
		method: 'DELETE',
		headers: { accept: 'application/json' }
	});
	if (!response.ok) throw new EvidenceClientError("Couldn't remove that file. Try again.");
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message.trim() : '';
		throw new EvidenceClientError(message || fallback);
	}
	return (body ?? {}) as T;
}

function isSafeSignedUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
	} catch {
		return false;
	}
}
