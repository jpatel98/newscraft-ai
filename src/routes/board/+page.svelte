<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import type { BoardChannel, BoardData, BoardPost, HermesJob } from '$lib/types';
	import { formatRelativeTime } from '$lib/utils/time';
	import Pause from 'lucide-svelte/icons/pause';
	import Play from 'lucide-svelte/icons/play';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';

	let channels = $state<BoardChannel[]>([]);
	let posts = $state<BoardPost[]>([]);
	let jobs = $state<HermesJob[]>([]);
	let jobsError = $state<string | null>(null);
	let selectedSlug = $state('');
	let selectedPostId = $state('');
	let busy = $state(true);
	let actionBusy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedChannel = $derived(
		channels.find((channel) => channel.slug === selectedSlug) ?? channels[0] ?? null
	);
	const selectedPosts = $derived(
		selectedChannel ? posts.filter((post) => post.channelSlug === selectedChannel.slug) : []
	);
	const selectedPost = $derived(
		selectedPosts.find((post) => post.id === selectedPostId) ?? selectedPosts[0] ?? null
	);
	const selectedJob = $derived(
		selectedChannel?.jobId ? jobs.find((job) => job.id === selectedChannel.jobId) ?? null : null
	);
	const activeJobCount = $derived(jobs.filter((job) => job.enabled).length);
	const latestRun = $derived(posts[0]?.runTime ?? channels[0]?.latestRunAt ?? null);

	onMount(() => {
		void loadBoard();
		return () => clearRunPoll();
	});

	async function loadBoard(preserveSelection = false, silent = false) {
		if (!silent) busy = true;
		error = null;
		try {
			const response = await fetch('/api/hermes/board', { cache: 'no-store' });
			if (!response.ok) throw new Error(`Board ${response.status}`);
			const data = (await response.json()) as BoardData;
			channels = data.channels ?? [];
			posts = data.posts ?? [];
			jobs = data.jobs ?? [];
			jobsError = data.jobsError ?? null;

			if (!preserveSelection || !channels.some((channel) => channel.slug === selectedSlug)) {
				selectedSlug = channels[0]?.slug ?? '';
			}
			const channelPosts = posts.filter((post) => post.channelSlug === selectedSlug);
			if (!preserveSelection || !channelPosts.some((post) => post.id === selectedPostId)) {
				selectedPostId = channelPosts[0]?.id ?? '';
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			if (!silent) busy = false;
		}
	}

	function selectChannel(channel: BoardChannel) {
		selectedSlug = channel.slug;
		selectedPostId = posts.find((post) => post.channelSlug === channel.slug)?.id ?? '';
	}

	function selectPost(post: BoardPost) {
		selectedPostId = post.id;
	}

	async function jobAction(action: 'run' | 'pause' | 'resume') {
		if (!selectedJob) return;
		const jobName = selectedJob.name;
		const channelSlug = selectedChannel?.slug ?? '';
		const previousLatest = selectedPosts[0]?.id ?? '';
		actionBusy = action;
		error = null;
		notice = null;
		try {
			const response = await fetch(
				`/api/hermes/jobs/${encodeURIComponent(selectedJob.id)}/${action}`,
				{ method: 'POST' }
			);
			if (!response.ok) throw new Error(await response.text());
			if (action === 'run') {
				notice = `${jobName} run requested. Waiting for the next report...`;
				startRunPoll(channelSlug, previousLatest);
			} else {
				notice = `${jobName} ${action === 'pause' ? 'paused' : 'resumed'}.`;
			}
			await loadBoard(true, action === 'run');
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			actionBusy = null;
		}
	}

	function clearRunPoll() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
	}

	function startRunPoll(channelSlug: string, previousLatest: string) {
		clearRunPoll();
		const stopAt = Date.now() + 10 * 60_000;
		const poll = async () => {
			await loadBoard(true, true);
			const latest = posts.find((post) => post.channelSlug === channelSlug);
			if (latest && latest.id !== previousLatest) {
				selectedSlug = channelSlug;
				selectedPostId = latest.id;
				notice = 'New report received.';
				clearRunPoll();
				return;
			}
			if (Date.now() >= stopAt) {
				notice = 'Run requested. The report is still running or waiting on Hermes.';
				clearRunPoll();
				return;
			}
			pollTimer = setTimeout(() => void poll(), 8000);
		};
		pollTimer = setTimeout(() => void poll(), 3000);
	}

	function formatDate(value: string | null | undefined): string {
		if (!value) return '—';
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	}

	function relativeDate(value: string | null | undefined): string {
		if (!value) return 'No runs yet';
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return value;
		return formatRelativeTime(date.getTime());
	}

	function statusLabel(channel: BoardChannel, job: HermesJob | null): string {
		if (!channel.active) return 'Archived';
		if (job?.lastStatus && job.lastStatus !== 'ok') return 'Error';
		if (isQueued(job)) return 'Queued';
		if (!job?.enabled || channel.state === 'paused') return 'Paused';
		return channel.state || 'Active';
	}

	function statusTone(channel: BoardChannel, job: HermesJob | null): 'ok' | 'warn' | 'error' | 'archived' {
		if (!channel.active) return 'archived';
		if (job?.lastStatus && job.lastStatus !== 'ok') return 'error';
		if (isQueued(job)) return 'warn';
		if (!job?.enabled || channel.state === 'paused') return 'warn';
		return 'ok';
	}

	function isQueued(job: HermesJob | null): boolean {
		if (!job?.enabled || !job.nextRunAt) return false;
		const next = Date.parse(job.nextRunAt);
		if (!Number.isFinite(next)) return false;
		const last = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
		return next <= Date.now() + 60_000 && (!Number.isFinite(last) || last < next);
	}
</script>

<svelte:head>
	<title>Board · NewsCraft</title>
</svelte:head>

<div class="page">
	<div class="board">
		<header class="board__masthead">
			<div>
				<div class="board__eyebrow">Hermes Notice Board</div>
				<h1 class="board__title">Board</h1>
				<p class="board__intro">Scheduled agent reports, grouped into newsroom channels.</p>
			</div>
			<button type="button" class="btn btn--ghost" onclick={() => loadBoard(true)} disabled={busy}>
				<RefreshCw size="14" strokeWidth={1.7} />
				{busy ? 'Refreshing' : 'Refresh'}
			</button>
		</header>

		{#if error}
			<div class="board__notice board__notice--error">{error}</div>
		{/if}
		{#if notice}
			<div class="board__notice">{notice}</div>
		{/if}
		{#if jobsError}
			<div class="board__notice">
				Saved reports loaded. Live job controls are unavailable: {jobsError}
			</div>
		{/if}

		<section class="board__stats" aria-label="Board summary">
			<div class="board__stat">
				<span>Channels</span>
				<strong>{channels.length}</strong>
			</div>
			<div class="board__stat">
				<span>Active jobs</span>
				<strong>{activeJobCount}</strong>
			</div>
			<div class="board__stat">
				<span>Latest report</span>
				<strong>{latestRun ? relativeDate(latestRun) : '—'}</strong>
			</div>
		</section>

		<div class="board__layout">
			<aside class="board__channels" aria-label="Channels">
				<div class="board__rail-title">Channels</div>
				{#if busy && channels.length === 0}
					<div class="board__empty">Loading board…</div>
				{:else}
					{#each channels as channel (channel.slug)}
						{@const job = jobs.find((candidate) => candidate.id === channel.jobId) ?? null}
						<button
							type="button"
							class="channel-row"
							class:channel-row--active={selectedChannel?.slug === channel.slug}
							onclick={() => selectChannel(channel)}
						>
							<span class="channel-row__main">
								<span class="channel-row__name">{channel.name}</span>
								<span class="channel-row__meta">
									{channel.postCount}
									{channel.postCount === 1 ? 'post' : 'posts'} · {relativeDate(channel.latestRunAt)}
								</span>
							</span>
							<span class={`board-status board-status--${statusTone(channel, job)}`}>
								{statusLabel(channel, job)}
							</span>
						</button>
					{:else}
						<div class="board__empty">No channels yet.</div>
					{/each}
				{/if}
			</aside>

			<section class="board__detail" aria-live="polite">
				{#if selectedChannel}
					<div class="board__detail-head">
						<div>
							<div class="board__eyebrow">Channel</div>
							<h2>{selectedChannel.name}</h2>
							<div class="board__detail-meta">
								<span class={`board-status board-status--${statusTone(selectedChannel, selectedJob)}`}>
									{statusLabel(selectedChannel, selectedJob)}
								</span>
								<span>{selectedChannel.postCount} saved reports</span>
								{#if selectedJob?.scheduleDisplay}
									<span>{selectedJob.scheduleDisplay}</span>
								{/if}
								{#if selectedJob?.nextRunAt}
									<span>Next: {formatDate(selectedJob.nextRunAt)}</span>
								{/if}
								{#if selectedJob?.lastRunAt}
									<span>Last: {formatDate(selectedJob.lastRunAt)}</span>
								{/if}
							</div>
						</div>
						{#if selectedJob}
							<div class="board__actions" aria-label="Job controls">
								{#if selectedJob.enabled}
									<button
										type="button"
										class="btn btn--ghost"
										disabled={Boolean(actionBusy)}
										onclick={() => jobAction('run')}
									>
										<Play size="13" strokeWidth={1.8} />
										{actionBusy === 'run' ? 'Running' : 'Run now'}
									</button>
									<button
										type="button"
										class="btn btn--ghost"
										disabled={Boolean(actionBusy)}
										onclick={() => jobAction('pause')}
									>
										<Pause size="13" strokeWidth={1.8} />
										{actionBusy === 'pause' ? 'Pausing' : 'Pause'}
									</button>
								{:else}
									<button
										type="button"
										class="btn btn--primary"
										disabled={Boolean(actionBusy)}
										onclick={() => jobAction('resume')}
									>
										<Play size="13" strokeWidth={1.8} />
										{actionBusy === 'resume' ? 'Resuming' : 'Resume'}
									</button>
								{/if}
							</div>
						{/if}
					</div>

					<div class="board__content">
						<div class="board__runs" aria-label="Saved reports">
							<div class="board__rail-title">Reports</div>
							{#each selectedPosts as post (post.id)}
								<button
									type="button"
									class="run-row"
									class:run-row--active={selectedPost?.id === post.id}
									onclick={() => selectPost(post)}
								>
									<span class="run-row__time">{formatDate(post.runTime)}</span>
									<span class="run-row__preview">{post.preview || 'No response body captured.'}</span>
								</button>
							{:else}
								<div class="board__empty">No saved reports for this channel yet.</div>
							{/each}
						</div>

						<article class="board__post">
							{#if selectedPost}
								<header class="board__post-head">
									<div>
										<div class="board__eyebrow">Report</div>
										<h3>{formatDate(selectedPost.runTime)}</h3>
									</div>
									<div class="board__post-meta">
										<span>Job {selectedPost.jobId}</span>
										<span>{selectedPost.schedule || selectedJob?.scheduleDisplay || 'No schedule'}</span>
										{#if selectedJob?.deliver}
											<span>Deliver: {selectedJob.deliver}</span>
										{/if}
										{#if selectedJob?.lastStatus}
											<span>Status: {selectedJob.lastStatus}</span>
										{/if}
									</div>
								</header>
								{#if selectedJob?.lastError || selectedJob?.lastDeliveryError}
									<div class="board__notice board__notice--error">
										{selectedJob.lastError || selectedJob.lastDeliveryError}
									</div>
								{/if}
								<div class="board__markdown">
									<Markdown content={selectedPost.responseMarkdown || '_No response body captured._'} />
								</div>
							{:else}
								<div class="board__empty board__empty--large">
									No report selected.
								</div>
							{/if}
						</article>
					</div>
				{:else}
					<div class="board__empty board__empty--large">
						No cron output found yet.
					</div>
				{/if}
			</section>
		</div>
	</div>
</div>

<style>
	.board {
		width: 100%;
		max-width: 1260px;
		margin: 0 auto;
		padding: 34px 28px 64px;
	}
	.board__masthead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 20px;
	}
	.board__eyebrow,
	.board__rail-title {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.board__title {
		font-family: var(--font-display);
		font-size: 34px;
		line-height: 1.02;
		letter-spacing: -0.028em;
		color: var(--fg-1);
		margin: 4px 0 0;
	}
	.board__intro {
		margin: 8px 0 0;
		max-width: 520px;
		font-size: 14px;
		line-height: 1.5;
		color: var(--fg-2);
	}
	.board__notice {
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
		color: var(--fg-2);
		border-radius: var(--radius-2);
		padding: 10px 12px;
		margin-bottom: 12px;
		font-size: 13px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}
	.board__notice--error {
		border-color: color-mix(in srgb, var(--flag-700) 24%, var(--border-soft));
		background: color-mix(in srgb, var(--flag-50) 36%, var(--bg-surface));
		color: var(--flag-700);
	}
	.board__stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		margin-bottom: 18px;
	}
	.board__stat {
		border-top: 1px solid var(--border-soft);
		padding-top: 10px;
		min-width: 0;
	}
	.board__stat span {
		display: block;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.board__stat strong {
		display: block;
		margin-top: 3px;
		font-family: var(--font-display);
		font-size: 18px;
		letter-spacing: -0.014em;
		color: var(--fg-1);
	}
	.board__layout {
		display: grid;
		grid-template-columns: minmax(210px, 280px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}
	.board__channels {
		min-width: 0;
		border-top: 1px solid var(--border-soft);
		padding-top: 10px;
		display: grid;
		gap: 5px;
	}
	.channel-row,
	.run-row {
		width: 100%;
		border: 1px solid transparent;
		border-radius: var(--radius-2);
		background: transparent;
		color: var(--fg-1);
		text-align: left;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std);
	}
	.channel-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
		padding: 10px;
	}
	.channel-row:hover,
	.channel-row--active,
	.run-row:hover,
	.run-row--active {
		background: var(--bg-surface);
		border-color: var(--border-soft);
	}
	.channel-row:focus-visible,
	.run-row:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
	.channel-row__main {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.channel-row__name {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		letter-spacing: -0.012em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.channel-row__meta {
		font-size: 12px;
		color: var(--fg-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.board-status {
		flex: 0 0 auto;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-pill);
		padding: 2px 6px;
		font-family: var(--font-mono);
		font-size: 10px;
		line-height: 1.35;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--fg-3);
		background: var(--bg-surface);
	}
	.board-status--ok {
		color: var(--status-verified-fg);
		background: var(--status-verified-bg);
		border-color: color-mix(in srgb, var(--status-verified) 18%, var(--border-soft));
	}
	.board-status--warn {
		color: var(--status-review-fg);
		background: var(--status-review-bg);
		border-color: color-mix(in srgb, var(--status-review) 24%, var(--border-soft));
	}
	.board-status--error {
		color: var(--status-breaking-fg);
		background: var(--status-breaking-bg);
		border-color: color-mix(in srgb, var(--status-breaking) 24%, var(--border-soft));
	}
	.board-status--archived {
		color: var(--fg-3);
		background: var(--bg-raised);
	}
	.board__detail {
		min-width: 0;
		border-top: 1px solid var(--border-soft);
		padding-top: 14px;
	}
	.board__detail-head,
	.board__post-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 14px;
	}
	.board__detail h2,
	.board__post h3 {
		font-family: var(--font-display);
		margin: 3px 0 0;
		color: var(--fg-1);
		letter-spacing: -0.018em;
		line-height: 1.15;
	}
	.board__detail h2 {
		font-size: 24px;
	}
	.board__post h3 {
		font-size: 18px;
	}
	.board__detail-meta,
	.board__post-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 7px;
		margin-top: 8px;
		font-size: 12px;
		color: var(--fg-3);
	}
	.board__detail-meta span:not(.board-status),
	.board__post-meta span {
		font-family: var(--font-mono);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.board__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 7px;
	}
	.board__content {
		display: grid;
		grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}
	.board__runs {
		min-width: 0;
		display: grid;
		gap: 5px;
	}
	.run-row {
		display: grid;
		gap: 3px;
		padding: 9px;
	}
	.run-row__time {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-2);
	}
	.run-row__preview {
		font-size: 12px;
		line-height: 1.35;
		color: var(--fg-3);
		overflow: hidden;
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.board__post {
		min-width: 0;
		background: var(--bg-surface);
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		padding: 18px;
	}
	.board__markdown {
		border-top: 1px solid var(--border-soft);
		padding-top: 16px;
	}
	.board__empty {
		padding: 12px 10px;
		color: var(--fg-3);
		font-size: 13px;
	}
	.board__empty--large {
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
		border-radius: var(--radius-2);
		padding: 24px;
	}
	@media (prefers-color-scheme: dark) {
		.board__notice--error {
			background: color-mix(in srgb, var(--flag-700) 14%, var(--bg-surface));
			color: var(--flag-300);
		}
	}
	@media (max-width: 960px) {
		.board__layout,
		.board__content {
			grid-template-columns: 1fr;
		}
	}
	@media (max-width: 620px) {
		.board {
			padding: 24px 16px 52px;
		}
		.board__masthead,
		.board__detail-head,
		.board__post-head {
			flex-direction: column;
		}
		.board__stats {
			grid-template-columns: 1fr;
		}
		.board__actions,
		.board__actions :global(.btn) {
			width: 100%;
		}
		.board__actions {
			justify-content: stretch;
		}
		.board__title {
			font-size: 30px;
		}
	}
</style>
