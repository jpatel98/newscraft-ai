import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { VpsStorageClient } from '$lib/server/storage/vps-client';
import { AUDIO_BUCKET, MAX_AUDIO_BYTES } from '$lib/utils/transcript-media';

export class AudioStorageUnavailableError extends Error {
	constructor() {
		super('Audio storage is unavailable right now.');
		this.name = 'AudioStorageUnavailableError';
	}
}

export type AudioStorage = {
	signUpload(key: string, contentType: string, bytes: number): Promise<string>;
	/** Size of the stored object, or null when nothing has been uploaded. */
	stat(key: string): Promise<{ bytes: number; contentType: string } | null>;
	signDownload(key: string, expiresInSeconds: number): Promise<string>;
	remove(key: string): Promise<void>;
};

export function createAudioStorage(options: {
	baseUrl?: string;
	apiKey?: string;
	fetchImpl?: typeof fetch;
} = {}): AudioStorage {
	const baseUrl = (options.baseUrl ?? env.NEWSCRAFT_STORAGE_BASE_URL ?? '').trim();
	const apiKey = (options.apiKey ?? env.NEWSCRAFT_STORAGE_API_KEY ?? '').trim();
	const bucket = (env.NEWSCRAFT_AUDIO_STORAGE_BUCKET ?? '').trim() || AUDIO_BUCKET;
	const client = baseUrl && apiKey
		? new VpsStorageClient({ baseUrl, apiKey, fetchImpl: options.fetchImpl, allowLoopbackHttp: dev })
		: null;
	const use = () => {
		if (!client) throw new AudioStorageUnavailableError();
		return client;
	};
	const guard = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (cause) {
			if (cause instanceof AudioStorageUnavailableError) throw cause;
			throw new AudioStorageUnavailableError();
		}
	};

	return {
		signUpload: (key, contentType, bytes) =>
			guard(async () => (await use().signUpload({ bucket, key, contentType, maxBytes: Math.min(bytes, MAX_AUDIO_BYTES) })).signedUrl),
		stat: (key) =>
			guard(async () => {
				const meta = await use().statLatest({ bucket, key });
				return meta ? { bytes: meta.bytes, contentType: meta.contentType } : null;
			}),
		signDownload: (key, expiresInSeconds) => guard(() => use().signDownload({ bucket, key, expiresInSeconds })),
		remove: (key) => guard(() => use().remove({ bucket, key }))
	};
}

let storage: AudioStorage | null = null;
export function getAudioStorage(): AudioStorage {
	storage ??= createAudioStorage();
	return storage;
}
