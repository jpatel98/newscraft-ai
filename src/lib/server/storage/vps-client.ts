import { isAllowedSignedStorageUrl } from '$lib/server/documents/signed-url';
import { boundedNetworkError } from '$lib/server/network/diagnostics';
import { fetchWithNewsCraftDns } from '$lib/server/network/http';

export interface VpsStorageClientOptions {
	baseUrl: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
	allowLoopbackHttp?: boolean;
}

export interface VpsObjectMetadata {
	key: string;
	version: string;
	bytes: number;
	checksumSha256: string;
	contentType: string;
	path: string;
}

export class VpsStorageError extends Error {
	readonly status: number;

	constructor(message: string, status = 503) {
		super(message);
		this.name = 'VpsStorageError';
		this.status = status;
	}
}

type SignUploadResponse = {
	path?: unknown;
	token?: unknown;
	url?: unknown;
	signedUrl?: unknown;
};

type SignDownloadResponse = { url?: unknown; signedUrl?: unknown };

/**
 * Small, server-only client for the NewsCraft storage gateway. The gateway
 * never receives the API key in a signed browser URL; the key is used only
 * for control-plane calls made by the SvelteKit server.
 */
export class VpsStorageClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: typeof fetch;
	private readonly allowLoopbackHttp: boolean;

	constructor(private readonly options: VpsStorageClientOptions) {
		const baseUrl = new URL(options.baseUrl);
		if (baseUrl.search || baseUrl.hash) throw new Error('storage base URL must not contain a query or fragment');
		if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
		this.baseUrl = baseUrl;
		this.fetchImpl = options.fetchImpl ?? fetchWithNewsCraftDns;
		this.allowLoopbackHttp = options.allowLoopbackHttp ?? false;
	}

	async signUpload(input: {
		bucket: string;
		key: string;
		maxBytes: number;
		contentType?: string;
	}): Promise<{ path: string; token: string; signedUrl: string }> {
		const body = await this.json('/v1/sign-upload', input) as SignUploadResponse;
		const signedUrl = this.signedUrl(body.signedUrl ?? body.url);
		const token = typeof body.token === 'string' ? body.token : '';
		const path = typeof body.path === 'string' && body.path ? body.path : input.key;
		if (!token || !signedUrl) throw new VpsStorageError('storage gateway returned an invalid upload token');
		return { path, token, signedUrl };
	}

	async signDownload(input: {
		bucket: string;
		key: string;
		expiresInSeconds: number;
	}): Promise<string> {
		const body = await this.json('/v1/sign-download', input) as SignDownloadResponse;
		const signedUrl = this.signedUrl(body.signedUrl ?? body.url);
		if (!signedUrl) throw new VpsStorageError('storage gateway returned an invalid download URL');
		return signedUrl;
	}

	async getObject(input: { bucket: string; key: string; version?: string }): Promise<Uint8Array> {
		const response = await this.request('/v1/object', {
			method: 'GET',
			query: input,
		});
		if (!response.ok) throw new VpsStorageError('storage object is unavailable', response.status);
		return new Uint8Array(await response.arrayBuffer());
	}

	async statLatest(input: { bucket: string; key: string }): Promise<VpsObjectMetadata | null> {
		return this.stat({ ...input });
	}

	async stat(input: { bucket: string; key: string; version?: string }): Promise<VpsObjectMetadata | null> {
		const response = await this.request('/v1/meta', { method: 'GET', query: input });
		if (response.status === 404) return null;
		if (!response.ok) throw new VpsStorageError('storage metadata is unavailable', response.status);
		return parseMetadata(await response.json());
	}

	async putObject(input: {
		bucket: string;
		key: string;
		contentType: string;
		bytes: Uint8Array;
	}): Promise<VpsObjectMetadata> {
		const response = await this.request('/v1/object', {
			method: 'PUT',
			query: { bucket: input.bucket, key: input.key, contentType: input.contentType },
			headers: { 'content-type': input.contentType, 'content-length': String(input.bytes.byteLength) },
			body: Buffer.from(input.bytes),
		});
		if (!response.ok) throw new VpsStorageError('storage object could not be written', response.status);
		const metadata = parseMetadata(await response.json());
		if (!metadata) throw new VpsStorageError('storage gateway returned invalid object metadata');
		return metadata;
	}

	async remove(input: { bucket: string; key: string; version?: string }): Promise<void> {
		const response = await this.request('/v1/object', { method: 'DELETE', query: input });
		if (!response.ok && response.status !== 404) throw new VpsStorageError('storage object could not be removed', response.status);
	}

	async verifyPolicy(bucket: string): Promise<{ private: boolean; maxBytes: number; mimeTypes: string[] }> {
		const response = await this.request('/v1/policy', { method: 'GET', query: { bucket } });
		if (!response.ok) throw new VpsStorageError('storage policy verification failed', response.status);
		const body = await response.json() as { private?: unknown; maxBytes?: unknown; mimeTypes?: unknown };
		if (body.private !== true || !Number.isSafeInteger(body.maxBytes) || !Array.isArray(body.mimeTypes) || !body.mimeTypes.every((value) => typeof value === 'string')) {
			throw new VpsStorageError('storage gateway policy is invalid');
		}
		return { private: true, maxBytes: body.maxBytes as number, mimeTypes: body.mimeTypes as string[] };
	}

	private signedUrl(value: unknown): string | null {
		if (typeof value !== 'string' || !isAllowedSignedStorageUrl(value, this.baseUrl.toString(), this.allowLoopbackHttp, true)) return null;
		return value;
	}

	private async json(path: string, body: unknown): Promise<unknown> {
		const response = await this.request(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new VpsStorageError('storage gateway request failed', response.status);
		return response.json();
	}

	private async request(
		path: string,
		input: {
			method: 'GET' | 'POST' | 'PUT' | 'DELETE';
			query?: Record<string, string | number | undefined>;
			headers?: Record<string, string>;
			body?: BodyInit | null;
		}
	): Promise<Response> {
		const url = new URL(path.replace(/^\/+/, ''), this.baseUrl);
		for (const [key, value] of Object.entries(input.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		try {
			return await this.fetchImpl(url, {
				method: input.method,
				headers: { 'x-storage-key': this.options.apiKey, ...(input.headers ?? {}) },
				body: input.body,
			});
		} catch (cause) {
			console.warn(
				'[newscraft] storage gateway request failed',
				boundedNetworkError(cause, this.baseUrl.hostname)
			);
			throw new VpsStorageError(cause instanceof Error ? cause.message : 'storage gateway request failed');
		}
	}
}

function parseMetadata(value: unknown): VpsObjectMetadata | null {
	if (!value || typeof value !== 'object') return null;
	const body = value as Record<string, unknown>;
	const key = typeof body.key === 'string' ? body.key : '';
	const version = typeof body.version === 'string' ? body.version : '';
	const bytes = typeof body.bytes === 'number' ? body.bytes : Number(body.bytes);
	const checksumSha256 = typeof body.checksumSha256 === 'string' ? body.checksumSha256 : '';
	const contentType = typeof body.contentType === 'string' ? body.contentType : '';
	if (!key || !version || !/^[a-f0-9]{32,80}$/u.test(version) || !Number.isSafeInteger(bytes) || bytes < 0 || !/^[a-f0-9]{64}$/u.test(checksumSha256) || !contentType) return null;
	return { key, version, bytes, checksumSha256, contentType, path: typeof body.path === 'string' ? body.path : key };
}
