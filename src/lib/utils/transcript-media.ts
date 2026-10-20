// Which recordings the transcriber accepts. Kept in step with the newsroom-audio
// bucket policy in infra/newscraft-storage/server.mjs.

export const AUDIO_BUCKET = 'newsroom-audio';
export const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

const EXTENSION_TYPES: Record<string, string> = {
	aac: 'audio/aac',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	mp3: 'audio/mpeg',
	mpeg: 'audio/mpeg',
	mpga: 'audio/mpeg',
	oga: 'audio/ogg',
	ogg: 'audio/ogg',
	opus: 'audio/ogg',
	wav: 'audio/wav',
	weba: 'audio/webm',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm'
};

export const ALLOWED_MEDIA_TYPES = new Set([
	'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-m4a', 'audio/x-wav',
	'video/mp4', 'video/quicktime', 'video/webm'
]);

/** The accept attribute for the file picker. */
export const MEDIA_ACCEPT = ['audio/*', 'video/mp4', 'video/quicktime', 'video/webm', ...Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`)].join(',');

/**
 * The content type to store a file under: the browser's type when it is one we
 * accept (codec parameters dropped), otherwise a guess from the extension.
 */
export function mediaTypeFor(fileName: string, browserType: string | null | undefined): string | null {
	const declared = (browserType ?? '').split(';', 1)[0].trim().toLowerCase();
	if (ALLOWED_MEDIA_TYPES.has(declared)) return declared;
	const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
	return ext ? EXTENSION_TYPES[ext] ?? null : null;
}

/** A title from a file name: "City council 10-20.m4a" becomes "City council 10-20". */
export function titleFromFileName(fileName: string): string {
	const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').trim();
	return base.slice(0, 200) || 'Untitled recording';
}
