import type { TranscriptDetail } from '$lib/utils/transcripts';
import { mediaTypeFor } from '$lib/utils/transcript-media';

export class TranscriptionClientError extends Error {}

async function readError(response: Response, fallback: string): Promise<string> {
	const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
	return typeof body?.message === 'string' && body.message ? body.message : fallback;
}

/** PUTs the file straight to storage, reporting progress from 0 to 1. */
function putWithProgress(url: string, file: Blob, contentType: string, onProgress: (fraction: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		xhr.setRequestHeader('content-type', contentType);
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress(event.loaded / event.total);
		};
		xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new TranscriptionClientError('The upload failed. Try again.')));
		xhr.onerror = () => reject(new TranscriptionClientError('The upload was interrupted. Check your connection and try again.'));
		xhr.send(file);
	});
}

export async function startTranscriptionProcessing(id: string): Promise<TranscriptDetail | null> {
	const response = await fetch(`/api/transcriptions/${id}/process`, { method: 'POST' });
	if (!response.ok) throw new TranscriptionClientError(await readError(response, 'Transcription could not start. Try again.'));
	return ((await response.json()) as { transcript: TranscriptDetail }).transcript;
}

/**
 * Creates the transcript, uploads the media and starts transcription. Resolves
 * with the new transcript id once the upload is stored; transcription carries on
 * in the background and the transcript page picks up the result.
 */
export async function submitMedia(input: {
	file: Blob;
	fileName: string;
	kind: 'upload' | 'recording';
	keyterms: string[];
	onProgress?: (fraction: number) => void;
}): Promise<string> {
	const contentType = mediaTypeFor(input.fileName, input.file.type);
	if (!contentType) throw new TranscriptionClientError('That file type isn’t supported. Use MP3, M4A, WAV, MP4, MOV or similar.');
	const response = await fetch('/api/transcriptions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: input.kind, fileName: input.fileName, contentType, bytes: input.file.size, keyterms: input.keyterms })
	});
	if (!response.ok) throw new TranscriptionClientError(await readError(response, 'Couldn’t start that transcription. Try again.'));
	const { transcript, upload } = (await response.json()) as {
		transcript: TranscriptDetail;
		upload: { url: string; contentType: string };
	};
	await putWithProgress(upload.url, input.file, upload.contentType, input.onProgress ?? (() => {}));
	void startTranscriptionProcessing(transcript.id).catch(() => {
		/* The transcript page shows the failure and offers a retry. */
	});
	return transcript.id;
}

export async function submitLink(url: string, keyterms: string[]): Promise<string> {
	const response = await fetch('/api/transcriptions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'link', url, keyterms })
	});
	if (!response.ok) throw new TranscriptionClientError(await readError(response, 'Couldn’t start that transcription. Try again.'));
	const { transcript } = (await response.json()) as { transcript: TranscriptDetail };
	void startTranscriptionProcessing(transcript.id).catch(() => {});
	return transcript.id;
}

/** "Jane Doe, Queen's Park; TTC" becomes three terms. */
export function parseKeyterms(value: string): string[] {
	return value
		.split(/[,;\n]/)
		.map((term) => term.trim())
		.filter(Boolean)
		.slice(0, 50);
}
