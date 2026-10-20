<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto, invalidate } from '$app/navigation';
	import AudioLines from 'lucide-svelte/icons/audio-lines';
	import Link2 from 'lucide-svelte/icons/link-2';
	import Mic from 'lucide-svelte/icons/mic';
	import Search from 'lucide-svelte/icons/search';
	import Square from 'lucide-svelte/icons/square';
	import Upload from 'lucide-svelte/icons/upload';
	import '$lib/styles/transcriptions.css';
	import { parseKeyterms, submitLink, submitMedia, TranscriptionClientError } from '$lib/client/transcription-jobs';
	import { MEDIA_ACCEPT } from '$lib/utils/transcript-media';
	import { formatClock, type TranscriptSummary } from '$lib/utils/transcripts';
	import { formatRelativeTime } from '$lib/utils/time';

	let { data } = $props();

	let active = true;
	let ready = $state(false);
	let busy = $state(false);
	let progress = $state<number | null>(null);
	let failure = $state('');
	let link = $state('');
	let terms = $state('');
	let query = $state('');
	let dragging = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	let recorder: MediaRecorder | null = null;
	let recordStream: MediaStream | null = null;
	let recordChunks: Blob[] = [];
	let recordStartedAt = 0;
	let recordTimer: ReturnType<typeof setInterval> | null = null;
	let recording = $state(false);
	let recordElapsed = $state(0);
	const canRecord = $derived(ready && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);

	const transcripts = $derived((data.transcripts ?? []) as TranscriptSummary[]);
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return transcripts;
		return transcripts.filter((t) => t.title.toLowerCase().includes(q) || t.preview.toLowerCase().includes(q));
	});
	const pending = $derived(transcripts.some((t) => t.status === 'uploading' || t.status === 'queued' || t.status === 'processing'));

	let poll: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (pending && !poll) poll = setInterval(() => void invalidate('app:transcriptions'), 4000);
		if (!pending && poll) {
			clearInterval(poll);
			poll = null;
		}
	});

	onMount(() => {
		ready = true;
	});
	onDestroy(() => {
		active = false;
		if (poll) clearInterval(poll);
		stopTracks();
	});

	function errorText(cause: unknown): string {
		return cause instanceof TranscriptionClientError ? cause.message : 'Something went wrong. Try again.';
	}

	async function sendFile(file: Blob, fileName: string, kind: 'upload' | 'recording') {
		if (busy) return;
		busy = true;
		failure = '';
		progress = 0;
		try {
			const id = await submitMedia({ file, fileName, kind, keyterms: parseKeyterms(terms), onProgress: (f) => (progress = f) });
			if (!active) return;
			await goto(`/transcriptions/${id}`, { invalidateAll: true });
		} catch (cause) {
			if (active) failure = errorText(cause);
		} finally {
			if (active) {
				busy = false;
				progress = null;
			}
		}
	}

	function onPick(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) void sendFile(file, file.name, 'upload');
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const file = event.dataTransfer?.files?.[0];
		if (file) void sendFile(file, file.name, 'upload');
	}

	async function sendLink(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !link.trim()) return;
		busy = true;
		failure = '';
		try {
			const id = await submitLink(link.trim(), parseKeyterms(terms));
			if (!active) return;
			link = '';
			await goto(`/transcriptions/${id}`, { invalidateAll: true });
		} catch (cause) {
			if (active) failure = errorText(cause);
		} finally {
			if (active) busy = false;
		}
	}

	function stopTracks() {
		recordStream?.getTracks().forEach((track) => track.stop());
		recordStream = null;
		if (recordTimer) clearInterval(recordTimer);
		recordTimer = null;
	}

	function recorderType(): string | undefined {
		for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
			if (MediaRecorder.isTypeSupported?.(type)) return type;
		}
		return undefined;
	}

	async function startRecording() {
		if (busy || recording) return;
		failure = '';
		try {
			recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			failure = 'Microphone access was blocked. Allow it in your browser settings to record.';
			return;
		}
		const mimeType = recorderType();
		recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
		recordChunks = [];
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) recordChunks.push(event.data);
		};
		recorder.onstop = () => {
			const type = (recorder?.mimeType || mimeType || 'audio/webm').split(';', 1)[0];
			const blob = new Blob(recordChunks, { type });
			stopTracks();
			recording = false;
			const ext = type === 'audio/mp4' ? 'm4a' : 'webm';
			const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
			if (blob.size > 0) void sendFile(blob, `Recording ${stamp}.${ext}`, 'recording');
		};
		recorder.start(1000);
		recordStartedAt = Date.now();
		recordElapsed = 0;
		recordTimer = setInterval(() => (recordElapsed = Date.now() - recordStartedAt), 500);
		recording = true;
	}

	function stopRecording() {
		if (recorder && recorder.state !== 'inactive') recorder.stop();
	}

	function statusLabel(t: TranscriptSummary): string {
		if (t.status === 'complete') return t.durationMs ? formatClock(t.durationMs) : 'Done';
		if (t.status === 'failed') return 'Failed';
		if (t.status === 'uploading') return 'Uploading';
		return 'Transcribing';
	}
</script>

<svelte:head><title>Transcriptions · NewsCraft</title></svelte:head>

<main class="tx-page">
	<header class="tx-head">
		<h1>Transcriptions</h1>
		<p>Upload or record an interview, or paste a link. Each transcript is saved here with speakers and timestamps.</p>
	</header>

	{#if !data.engineReady}
		<p class="tx-notice" role="status">Transcription isn't switched on for this workspace yet. An admin needs to add the transcription key.</p>
	{/if}

	<section class="tx-new" aria-label="New transcription">
		<div
			class="tx-drop {dragging ? 'tx-drop--over' : ''}"
			role="presentation"
			ondragover={(e) => {
				e.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={onDrop}
		>
			{#if recording}
				<div class="tx-recording" aria-live="polite">
					<span class="tx-recording__dot" aria-hidden="true"></span>
					<span>Recording {formatClock(recordElapsed)}</span>
					<button type="button" class="tx-btn tx-btn--primary" onclick={stopRecording}>
						<Square size="14" strokeWidth={2} /> Stop and transcribe
					</button>
				</div>
			{:else if progress !== null}
				<div class="tx-progress" aria-live="polite">
					<span>Uploading {Math.round(progress * 100)}%</span>
					<div class="tx-progress__bar"><div style="width:{Math.round(progress * 100)}%"></div></div>
					<span class="tx-hint">Keep this tab open until the upload finishes.</span>
				</div>
			{:else}
				<div class="tx-actions">
					<button type="button" class="tx-btn tx-btn--primary" disabled={!ready || busy} onclick={() => fileInput?.click()}>
						<Upload size="15" strokeWidth={1.8} /> Upload a file
					</button>
					<button type="button" class="tx-btn" disabled={!canRecord || busy} onclick={startRecording}>
						<Mic size="15" strokeWidth={1.8} /> Record
					</button>
				</div>
				<p class="tx-hint">Audio or video up to 1 GB and 10 hours. Drop a file here, too.</p>
			{/if}
			<input bind:this={fileInput} type="file" accept={MEDIA_ACCEPT} hidden onchange={onPick} />
		</div>

		<form class="tx-link" onsubmit={sendLink}>
			<label for="tx-link-input"><Link2 size="14" strokeWidth={1.8} /> Or paste a link</label>
			<div>
				<input
					id="tx-link-input"
					type="url"
					inputmode="url"
					bind:value={link}
					placeholder="https:// a YouTube video, a press conference stream, an MP3"
					disabled={!ready || busy || recording}
				/>
				<button class="tx-btn" disabled={!ready || busy || recording || !link.trim()}>Transcribe</button>
			</div>
		</form>

		<div class="tx-terms">
			<label for="tx-terms-input">Names and terms in the recording (optional)</label>
			<input
				id="tx-terms-input"
				bind:value={terms}
				placeholder="e.g. Olivia Chow, Queen's Park, Metrolinx"
				disabled={!ready || busy || recording}
			/>
			<p class="tx-hint">Separate with commas. Spelling them out helps the transcript get them right.</p>
		</div>

		{#if failure}<p class="tx-error" role="alert">{failure}</p>{/if}
	</section>

	<section class="tx-library" aria-label="Your transcriptions">
		<div class="tx-library__head">
			<h2>Your transcriptions</h2>
			{#if transcripts.length > 0}
				<div class="tx-search">
					<Search size="13" strokeWidth={1.6} />
					<input bind:value={query} type="search" placeholder="Search titles and text" aria-label="Search transcriptions" />
				</div>
			{/if}
		</div>
		{#if transcripts.length === 0}
			<p class="tx-empty">Nothing yet. Your first transcript will show up here.</p>
		{:else if filtered.length === 0}
			<p class="tx-empty">No transcripts match “{query}”.</p>
		{:else}
			<ul class="tx-list">
				{#each filtered as t (t.id)}
					<li>
						<a href={`/transcriptions/${t.id}`}>
							<AudioLines size="15" strokeWidth={1.6} />
							<span class="tx-list__main">
								<strong>{t.title}</strong>
								{#if t.preview}<span class="tx-list__preview">{t.preview}</span>{/if}
							</span>
							<span class="tx-list__meta">
								<span class="tx-status tx-status--{t.status}">{statusLabel(t)}</span>
								<span>{formatRelativeTime(t.createdAt)}</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>
