export interface ConversationDocumentSummary {
	id: string;
	filename: string;
	state: 'uploading' | 'processing' | 'ready' | 'failed';
	pageCount: number | null;
	error: string | null;
}

interface SignedUploadResult {
	document: ConversationDocumentSummary;
	upload: {
		path: string;
		token: string;
		signedUrl: string;
	};
}

interface UploadConversationPdfOptions {
	fetch?: typeof fetch;
	onCreated?: (document: ConversationDocumentSummary) => void;
	onProcessing?: (document: ConversationDocumentSummary) => void;
}

export class ConversationDocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConversationDocumentError';
	}
}

export async function documentsCapabilityEnabled(fetchImpl: typeof fetch = fetch): Promise<boolean> {
	try {
		const response = await fetchImpl('/api/health?capabilities=1', {
			headers: { accept: 'application/json' },
			cache: 'no-store'
		});
		if (!response.ok) return false;
		const body = (await response.json()) as {
			app?: { capabilities?: { documents?: boolean } };
		};
		return body.app?.capabilities?.documents === true;
	} catch {
		return false;
	}
}

export async function uploadConversationPdf(
	conversationId: string,
	file: File,
	options: UploadConversationPdfOptions = {}
): Promise<ConversationDocumentSummary> {
	const fetchImpl = options.fetch ?? fetch;
	const checksumSha256 = await sha256Hex(file);
	const tokenResponse = await fetchImpl(
		`/api/conversations/${encodeURIComponent(conversationId)}/documents/upload-token`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				documents: [
					{
						filename: file.name,
						mimeType: 'application/pdf',
						sizeBytes: file.size,
						checksumSha256
					}
				]
			})
		}
	);
	const tokenBody = await responseJson<{ documents?: SignedUploadResult[] }>(
		tokenResponse,
		"Couldn't prepare that PDF. Try again."
	);
	const created = tokenBody.documents?.[0];
	if (!created?.document?.id || !isSafeSignedUploadUrl(created.upload?.signedUrl)) {
		throw new ConversationDocumentError("Couldn't prepare that PDF. Try again.");
	}
	options.onCreated?.(created.document);

	const form = new FormData();
	form.append('cacheControl', '3600');
	form.append('', file);
	const uploadResponse = await fetchImpl(created.upload.signedUrl, {
		method: 'PUT',
		headers: { 'x-upsert': 'false' },
		body: form
	});
	if (!uploadResponse.ok) {
		throw new ConversationDocumentError("Couldn't upload that PDF. Try again.");
	}

	const processing = { ...created.document, state: 'processing' as const };
	options.onProcessing?.(processing);
	const processResponse = await fetchImpl(
		`/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(created.document.id)}/process`,
		{ method: 'POST', headers: { accept: 'application/json' } }
	);
	const processBody = await responseJson<{ document?: ConversationDocumentSummary }>(
		processResponse,
		"Couldn't process that PDF. Try again."
	);
	if (!processBody.document || processBody.document.state !== 'ready') {
		throw new ConversationDocumentError("Couldn't process that PDF. Try again.");
	}
	return processBody.document;
}

export async function deleteConversationDocument(
	conversationId: string,
	documentId: string,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	const response = await fetchImpl(
		`/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}`,
		{ method: 'DELETE', headers: { accept: 'application/json' } }
	);
	if (!response.ok) throw new ConversationDocumentError("Couldn't remove that PDF. Try again.");
}

export async function sha256Hex(file: Blob): Promise<string> {
	const bytes = await file.arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const message = publicMessage(body);
		throw new ConversationDocumentError(message ?? fallback);
	}
	return (body ?? {}) as T;
}

function publicMessage(body: unknown): string | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	const message = (body as Record<string, unknown>).message;
	return typeof message === 'string' && message.trim() ? message.trim() : null;
}

function isSafeSignedUploadUrl(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname));
	} catch {
		return false;
	}
}

function isLocalHostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
