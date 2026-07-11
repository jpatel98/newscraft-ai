import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { DOCUMENT_BUCKET, MAX_PDF_BYTES, PDF_MIME_TYPE } from './constants';
import { DocumentError } from './errors';
import type { DocumentStorage } from './types';
import { isAllowedSignedStorageUrl } from './signed-url';
import { createClient } from '@supabase/supabase-js';

interface SupabaseResult<T> {
	data: T | null;
	error: unknown | null;
}

interface SupabaseBucket {
	createSignedUploadUrl(path: string, options: { upsert: false }): Promise<SupabaseResult<{
		path: string;
		token: string;
		signedUrl: string;
	}>>;
	download(path: string): Promise<SupabaseResult<Blob>>;
	createSignedUrl(path: string, expiresIn: number): Promise<SupabaseResult<{ signedUrl: string }>>;
	remove(paths: string[]): Promise<SupabaseResult<unknown>>;
}

interface SupabaseClient {
	storage: {
		from(bucket: string): SupabaseBucket;
		getBucket(bucket: string): Promise<
			SupabaseResult<{
				public: boolean;
				file_size_limit?: number;
				allowed_mime_types?: string[];
			}>
		>;
	};
}

interface SupabaseModule {
	createClient(
		url: string,
		key: string,
		options: { auth: { persistSession: false; autoRefreshToken: false; detectSessionInUrl: false } }
	): SupabaseClient;
}

type SupabaseLoader = () => Promise<SupabaseModule>;

async function loadSupabase(): Promise<SupabaseModule> {
	return { createClient } as unknown as SupabaseModule;
}

export function createSupabaseDocumentStorage(options: {
	url?: string;
	serviceRoleKey?: string;
	bucket?: string;
	loadModule?: SupabaseLoader;
	allowLoopbackHttp?: boolean;
} = {}): DocumentStorage {
	const url = options.url ?? env.SUPABASE_URL ?? '';
	const serviceRoleKey = options.serviceRoleKey ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
	const bucketName = options.bucket ?? DOCUMENT_BUCKET;
	const loader = options.loadModule ?? loadSupabase;
	const allowLoopbackHttp = options.allowLoopbackHttp ?? dev;
	let clientPromise: Promise<SupabaseClient> | undefined;

	async function client(): Promise<SupabaseClient> {
		if (!url || !serviceRoleKey) {
			throw unavailable();
		}
		clientPromise ??= loader()
			.then((supabase) =>
				supabase.createClient(url, serviceRoleKey, {
					auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
				})
			)
			.catch(() => {
				throw unavailable();
			});
		return clientPromise;
	}

	async function bucket(): Promise<SupabaseBucket> {
		return (await client()).storage.from(bucketName);
	}

	return {
		async createSignedUpload(path) {
			const result = await (await bucket()).createSignedUploadUrl(path, { upsert: false });
			if (
				result.error ||
				!result.data?.token ||
				!result.data.signedUrl ||
				!isAllowedSignedStorageUrl(result.data.signedUrl, url, allowLoopbackHttp)
			) {
				throw unavailable();
			}
			return {
				path: result.data.path || path,
				token: result.data.token,
				signedUrl: result.data.signedUrl
			};
		},
		async download(path) {
			const result = await (await bucket()).download(path);
			if (result.error || !result.data) {
				throw new DocumentError(409, 'upload_not_ready', 'The PDF upload is not ready.');
			}
			return new Uint8Array(await result.data.arrayBuffer());
		},
		async createSignedDownload(path, expiresInSeconds) {
			const result = await (await bucket()).createSignedUrl(path, expiresInSeconds);
			if (
				result.error ||
				!result.data?.signedUrl ||
				!isAllowedSignedStorageUrl(result.data.signedUrl, url, allowLoopbackHttp)
			) {
				throw unavailable();
			}
			return result.data.signedUrl;
		},
		async remove(paths) {
			if (paths.length === 0) return;
			const result = await (await bucket()).remove(paths);
			if (result.error) throw unavailable();
		},
		async verifyPrivateBucket() {
			const storage = (await client()).storage;
			const result = await storage.getBucket(bucketName);
			const allowedMimeTypes = result.data?.allowed_mime_types ?? [];
			if (
				result.error ||
				!result.data ||
				result.data.public ||
				result.data.file_size_limit !== MAX_PDF_BYTES ||
				allowedMimeTypes.length !== 1 ||
				allowedMimeTypes[0] !== PDF_MIME_TYPE
			) {
				throw unavailable();
			}
		}
	};
}

function unavailable(): DocumentError {
	return new DocumentError(503, 'document_storage_unavailable', 'PDF storage is unavailable right now.');
}
