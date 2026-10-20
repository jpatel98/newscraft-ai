<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import ArrowLeft from 'lucide-svelte/icons/arrow-left';
	import Copy from 'lucide-svelte/icons/copy';
	import Download from 'lucide-svelte/icons/download';
	import MessageSquarePlus from 'lucide-svelte/icons/message-square-plus';
	import Pencil from 'lucide-svelte/icons/pencil';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import Search from 'lucide-svelte/icons/search';
	import Trash2 from 'lucide-svelte/icons/trash-2';
	import '$lib/styles/transcriptions.css';
	import { startTranscriptionProcessing, TranscriptionClientError } from '$lib/client/transcription-jobs';
	import { composerDraftStorageKey, writeComposerDraft } from '$lib/utils/composer-drafts';
	import {
		buildChatDraft,
		buildPlainText,
		buildSrt,
		exportBaseName,
		formatClock,
		speakerLabel,
		type TranscriptDetail,
		type TranscriptUtterance
	} from '$lib/utils/transcripts';

	let { data } = $props();
	const t = $derived(data.transcript as TranscriptDetail);

	let audio = $state<HTMLAudioElement | null>(null);
	let currentMs = $state(0);
	let query = $state('');
	let notice = $state('');
	let failure = $state('');
	let busy = $state(false);
	let titleDraft = $state<string | null>(null);
	let speakerDraft = $state<{ id: string; name: string } | null>(null);
	let textDraft = $state<{ id: string; text: string } | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | null = null;

	const working = $derived(t.status === 'uploading' || t.status === 'queued' || t.status === 'processing');
	const speakers = $derived([...new Set(t.utterances.map((u) => u.speaker))]);
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return null;
		return new Set(t.utterances.filter((u) => u.text.toLowerCase().includes(q)).map((u) => u.id));
	});
	const activeId = $derived.by(() => {
		if (!audio || currentMs <= 0) return null;
		let found: string | null = null;
		for (const u of t.utterances) {
			if (u.start <= currentMs) found = u.id;
			else break;
		}
		return found;
	});

	// Poll while the transcript is being made; nudge a run that never started.
	let poll: ReturnType<typeof setInterval> | null = null;
	let nudged = false;
	$effect(() => {
		if (working && !poll) {
			poll = setInterval(() => void invalidate('app:transcript'), 3000);
		}
		if (!working && poll) {
			clearInterval(poll);
			poll = null;
		}
		if (working && !nudged && t.status !== 'processing' && Date.now() - t.updatedAt > 20_000) {
			nudged = true;
			void retry(false);
		}
	});
	onDestroy(() => {
		if (poll) clearInterval(poll);
		if (noticeTimer) clearTimeout(noticeTimer);
	});

	function flash(message: string) {
		notice = message;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = ''), 2500);
	}

	async function patch(body: Record<string, unknown>): Promise<boolean> {
		failure = '';
		const response = await fetch(`/api/transcriptions/${t.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}).catch(() => null);
		if (!response?.ok) {
			failure = 'That change wasn’t saved. Try again.';
			return false;
		}
		await invalidate('app:transcript');
		return true;
	}

	async function saveTitle() {
		const next = titleDraft?.trim();
		titleDraft = null;
		if (next && next !== t.title) await patch({ title: next });
	}

	async function saveSpeaker() {
		const draft = speakerDraft;
		speakerDraft = null;
		if (draft && draft.name.trim() !== (t.speakerNames[draft.id] ?? '')) await patch({ speaker: { id: draft.id, name: draft.name } });
	}

	async function saveText() {
		const draft = textDraft;
		if (!draft) return;
		if (!draft.text.trim()) {
			failure = 'A turn can’t be empty.';
			return;
		}
		if (await patch({ utterance: draft })) textDraft = null;
	}

	async function retry(manual = true) {
		if (busy) return;
		busy = manual;
		failure = '';
		try {
			await startTranscriptionProcessing(t.id);
		} catch (cause) {
			if (manual) failure = cause instanceof TranscriptionClientError ? cause.message : 'Couldn’t start transcription. Try again.';
		} finally {
			busy = false;
			await invalidate('app:transcript');
		}
	}

	function seek(ms: number) {
		if (!audio) return;
		audio.currentTime = ms / 1000;
		void audio.play().catch(() => {});
	}

	async function copyAll() {
		try {
			await navigator.clipboard.writeText(buildPlainText(t.utterances, t.speakerNames));
			flash('Copied');
		} catch {
			failure = 'Couldn’t copy. Your browser blocked the clipboard.';
		}
	}

	async function copyTurn(u: TranscriptUtterance) {
		const line = `${speakerLabel(u.speaker, t.speakerNames)} (${formatClock(u.start)}): “${u.text.trim()}”`;
		try {
			await navigator.clipboard.writeText(line);
			flash('Quote copied');
		} catch {
			failure = 'Couldn’t copy. Your browser blocked the clipboard.';
		}
	}

	function download(ext: 'txt' | 'srt') {
		const body = ext === 'txt' ? buildPlainText(t.utterances, t.speakerNames) : buildSrt(t.utterances, t.speakerNames);
		const blob = new Blob([body], { type: ext === 'txt' ? 'text/plain;charset=utf-8' : 'application/x-subrip;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${exportBaseName(t.title)}.${ext}`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	async function useInChat() {
		let storage: Storage | null = null;
		try {
			storage = window.localStorage;
		} catch {
			storage = null;
		}
		writeComposerDraft(storage, composerDraftStorageKey('new'), buildChatDraft(t.title, t.utterances, t.speakerNames));
		await goto('/');
	}

	async function remove() {
		if (!confirm(`Delete “${t.title}”? The recording and transcript are removed for good.`)) return;
		const response = await fetch(`/api/transcriptions/${t.id}`, { method: 'DELETE' }).catch(() => null);
		if (!response?.ok) {
			failure = 'Couldn’t delete it. Try again.';
			return;
		}
		await goto('/transcriptions');
		await invalidateAll();
	}

	function highlight(text: string): { text: string; hit: boolean }[] {
		const q = query.trim();
		if (!q) return [{ text, hit: false }];
		const parts: { text: string; hit: boolean }[] = [];
		const lower = text.toLowerCase();
		const needle = q.toLowerCase();
		let at = 0;
		for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
			if (i > at) parts.push({ text: text.slice(at, i), hit: false });
			parts.push({ text: text.slice(i, i + needle.length), hit: true });
			at = i + needle.length;
		}
		if (at < text.length) parts.push({ text: text.slice(at), hit: false });
		return parts;
	}

	function sourceLine(): string {
		const bits: string[] = [];
		if (t.durationMs) bits.push(formatClock(t.durationMs));
		bits.push(new Date(t.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
		if (t.sourceKind === 'recording') bits.push('Recorded here');
		else if (t.sourceName) bits.push(t.sourceName);
		if (speakers.length) bits.push(`${speakers.length} speaker${speakers.length === 1 ? '' : 's'}`);
		return bits.join(' · ');
	}
</script>

<svelte:head><title>{t.title} · Transcriptions · NewsCraft</title></svelte:head>

<main class="tx-page tx-page--detail">
	<a class="tx-back" href="/transcriptions"><ArrowLeft size="14" strokeWidth={1.8} /> Transcriptions</a>

	<header class="tx-detail-head">
		{#if titleDraft !== null}
			<form
				class="tx-title-form"
				onsubmit={(e) => {
					e.preventDefault();
					void saveTitle();
				}}
			>
				<!-- svelte-ignore a11y_autofocus -->
				<input bind:value={titleDraft} maxlength="200" aria-label="Title" autofocus onblur={saveTitle} />
			</form>
		{:else}
			<h1>
				<button type="button" class="tx-title" onclick={() => (titleDraft = t.title)} title="Rename">
					{t.title}
					<Pencil size="14" strokeWidth={1.6} />
				</button>
			</h1>
		{/if}
		<p class="tx-meta">{sourceLine()}</p>
		{#if t.sourceUrl}
			<p class="tx-meta"><a href={t.sourceUrl} target="_blank" rel="noopener noreferrer">{t.sourceUrl}</a></p>
		{/if}
	</header>

	{#if t.hasAudio}
		<div class="tx-player">
			<audio
				bind:this={audio}
				controls
				preload="metadata"
				src={`/api/transcriptions/${t.id}/audio`}
				ontimeupdate={() => (currentMs = (audio?.currentTime ?? 0) * 1000)}
			></audio>
		</div>
	{/if}

	{#if working}
		<div class="tx-working" role="status">
			<span class="tx-spinner" aria-hidden="true"></span>
			<span>{t.status === 'uploading' ? 'Waiting for the upload to finish…' : 'Transcribing. This usually takes under a minute for an hour of audio.'}</span>
		</div>
	{:else if t.status === 'failed'}
		<div class="tx-failed" role="alert">
			<p>{t.errorMessage || 'Transcription failed.'}</p>
			<button type="button" class="tx-btn" disabled={busy} onclick={() => retry(true)}>
				<RotateCcw size="14" strokeWidth={1.8} /> {busy ? 'Trying again…' : 'Try again'}
			</button>
		</div>
	{/if}

	{#if t.status === 'complete'}
		<div class="tx-toolbar">
			<div class="tx-search">
				<Search size="13" strokeWidth={1.6} />
				<input bind:value={query} type="search" placeholder="Find in transcript" aria-label="Find in transcript" />
				{#if matches}<span class="tx-hint">{matches.size} turn{matches.size === 1 ? '' : 's'}</span>{/if}
			</div>
			<div class="tx-toolbar__actions">
				<button type="button" class="tx-btn tx-btn--small" onclick={copyAll}><Copy size="13" strokeWidth={1.8} /> Copy</button>
				<button type="button" class="tx-btn tx-btn--small" onclick={() => download('txt')}><Download size="13" strokeWidth={1.8} /> .txt</button>
				<button type="button" class="tx-btn tx-btn--small" onclick={() => download('srt')}><Download size="13" strokeWidth={1.8} /> .srt</button>
				<button type="button" class="tx-btn tx-btn--small" onclick={useInChat}><MessageSquarePlus size="13" strokeWidth={1.8} /> Use in chat</button>
			</div>
		</div>

		{#if speakers.length > 0}
			<div class="tx-speakers" aria-label="Speakers">
				{#each speakers as id (id)}
					{#if speakerDraft?.id === id}
						<form
							onsubmit={(e) => {
								e.preventDefault();
								void saveSpeaker();
							}}
						>
							<!-- svelte-ignore a11y_autofocus -->
							<input bind:value={speakerDraft.name} maxlength="80" placeholder={speakerLabel(id)} aria-label="Speaker name" autofocus onblur={saveSpeaker} />
						</form>
					{:else}
						<button type="button" class="tx-chip" title="Name this speaker" onclick={() => (speakerDraft = { id, name: t.speakerNames[id] ?? '' })}>
							{speakerLabel(id, t.speakerNames)} <Pencil size="11" strokeWidth={1.6} />
						</button>
					{/if}
				{/each}
			</div>
		{/if}

		<ol class="tx-turns">
			{#each t.utterances as u (u.id)}
				<li class="tx-turn {activeId === u.id ? 'tx-turn--active' : ''} {matches && !matches.has(u.id) ? 'tx-turn--dim' : ''}">
					<div class="tx-turn__head">
						<span class="tx-turn__speaker">{speakerLabel(u.speaker, t.speakerNames)}</span>
						{#if t.hasAudio}
							<button type="button" class="tx-turn__time" onclick={() => seek(u.start)} title="Play from here">{formatClock(u.start)}</button>
						{:else}
							<span class="tx-turn__time">{formatClock(u.start)}</span>
						{/if}
						<span class="tx-turn__tools">
							<button type="button" title="Copy as quote" aria-label="Copy as quote" onclick={() => copyTurn(u)}><Copy size="12" strokeWidth={1.7} /></button>
							<button type="button" title="Edit text" aria-label="Edit text" onclick={() => (textDraft = { id: u.id, text: u.text })}><Pencil size="12" strokeWidth={1.7} /></button>
						</span>
					</div>
					{#if textDraft?.id === u.id}
						<div class="tx-edit">
							<textarea bind:value={textDraft.text} rows="4" aria-label="Turn text"></textarea>
							<div>
								<button type="button" class="tx-btn tx-btn--small tx-btn--primary" onclick={saveText}>Save</button>
								<button type="button" class="tx-btn tx-btn--small" onclick={() => (textDraft = null)}>Cancel</button>
							</div>
						</div>
					{:else if t.hasAudio && u.words.length > 0 && !query.trim()}
						<p class="tx-turn__text">
							{#each u.words as w, i (i)}<button
									type="button"
									class="tx-word {currentMs >= w.start && currentMs < w.end + 120 && activeId === u.id ? 'tx-word--now' : ''}"
									onclick={() => seek(w.start)}>{w.text}</button
								>{' '}{/each}
						</p>
					{:else}
						<p class="tx-turn__text">
							{#each highlight(u.text) as part, i (i)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
						</p>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}

	{#if failure}<p class="tx-error" role="alert">{failure}</p>{/if}
	{#if notice}<p class="tx-toast" role="status">{notice}</p>{/if}

	<footer class="tx-foot">
		<button type="button" class="tx-btn tx-btn--small tx-btn--danger" onclick={remove}><Trash2 size="13" strokeWidth={1.8} /> Delete</button>
	</footer>
</main>
