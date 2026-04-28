<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import type { BoardChannel, BoardData, BoardPost, HermesJob, HermesRun } from '$lib/types';
	import { detectRunRequestOutcome } from '$lib/utils/run-poll';
	import { effectiveRunError } from '$lib/utils/cron-delivery';
	import { formatRelativeTime } from '$lib/utils/time';
	import Check from 'lucide-svelte/icons/check';
	import Copy from 'lucide-svelte/icons/copy';
	import ExternalLink from 'lucide-svelte/icons/external-link';
	import Pause from 'lucide-svelte/icons/pause';
	import Play from 'lucide-svelte/icons/play';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';

	type ReportScope = 'latest' | 'all';
	type HermesJobWithRun = HermesJob & { currentRun?: HermesRun | null };

	let channels = $state<BoardChannel[]>([]);
	let posts = $state<BoardPost[]>([]);
	let jobs = $state<HermesJob[]>([]);
	let runs = $state<HermesRun[]>([]);
	let jobsError = $state<string | null>(null);
	let selectedSlug = $state('');
	let selectedPostId = $state('');
	let reportScope = $state<ReportScope>('latest');
	let busy = $state(true);
	let actionBusy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let copiedReportId = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let silentRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedChannel = $derived(
		channels.find((channel) => channel.slug === selectedSlug) ?? channels[0] ?? null
	);
	const selectedPosts = $derived(
		selectedChannel ? posts.filter((post) => post.channelSlug === selectedChannel.slug) : []
	);
	const visiblePosts = $derived(reportScope === 'latest' ? selectedPosts.slice(0, 1) : selectedPosts);
	const selectedPost = $derived(
		selectedPosts.find((post) => post.id === selectedPostId) ?? selectedPosts[0] ?? null
	);
	const selectedJob = $derived(
		selectedChannel?.jobId ? jobs.find((job) => job.id === selectedChannel.jobId) ?? null : null
	);
	const selectedRun = $derived(currentRunForJob(selectedChannel, selectedJob));
	const selectedRecentRun = $derived(selectedChannel?.recentRun ?? selectedRun ?? null);
	const selectedRunError = $derived(
		effectiveRunError({
			lastError: selectedRun?.lastError || selectedRecentRun?.lastError || selectedJob?.lastError || null,
			lastDeliveryError: selectedJob?.lastDeliveryError || null,
			deliver: selectedJob?.deliver || null
		})
	);
	const selectedJobRunning = $derived(Boolean(selectedRun));
	const activeJobCount = $derived(jobs.filter((job) => job.enabled).length);
	const latestRun = $derived(posts[0]?.runTime ?? channels[0]?.latestRunAt ?? null);

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		selectedSlug = params.get('channel') ?? '';
		selectedPostId = params.get('report') ?? '';
		if (selectedPostId) reportScope = 'all';
		void loadBoard(true);
		silentRefreshTimer = setInterval(() => {
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			void loadBoard(true, true);
		}, 15_000);
		return () => {
			clearRunPoll();
			if (silentRefreshTimer) clearInterval(silentRefreshTimer);
			clearCopiedTimer();
		};
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
			runs = data.runs ?? [];
			jobsError = data.jobsError ?? null;

			if (!preserveSelection || !channels.some((channel) => channel.slug === selectedSlug)) {
				selectedSlug = channels[0]?.slug ?? '';
			}
			const channelPosts = posts.filter((post) => post.channelSlug === selectedSlug);
			if (!preserveSelection || !channelPosts.some((post) => post.id === selectedPostId)) {
				selectedPostId = channelPosts[0]?.id ?? '';
			}
			syncReportScopeSelection();
			replaceReportUrl();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			if (!silent) busy = false;
		}
	}

	function selectChannel(channel: BoardChannel) {
		selectedSlug = channel.slug;
		selectedPostId = posts.find((post) => post.channelSlug === channel.slug)?.id ?? '';
		reportScope = 'latest';
		replaceReportUrl();
	}

	function selectPost(post: BoardPost) {
		selectedPostId = post.id;
		if (post.id !== selectedPosts[0]?.id) reportScope = 'all';
		replaceReportUrl();
	}

	function setReportScope(scope: ReportScope) {
		reportScope = scope;
		syncReportScopeSelection();
		replaceReportUrl();
	}

	function syncReportScopeSelection() {
		if (reportScope === 'latest') {
			selectedPostId = selectedPosts[0]?.id ?? '';
			return;
		}
		if (!selectedPosts.some((post) => post.id === selectedPostId)) {
			selectedPostId = selectedPosts[0]?.id ?? '';
		}
	}

	async function jobAction(action: 'run' | 'pause' | 'resume') {
		if (!selectedJob) return;
		const jobName = selectedJob.name;
		const channelSlug = selectedChannel?.slug ?? '';
		const previousLatest = selectedPosts[0]?.id ?? '';
		const previousLastRunAt = selectedJob.lastRunAt ?? null;
		const requestedAt = Date.now();
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
				startRunPoll({
					jobId: selectedJob.id,
					channelSlug,
					previousLatest,
					previousLastRunAt,
					requestedAt
				});
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

	function clearCopiedTimer() {
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = null;
	}

	function startRunPoll(input: {
		jobId: string;
		channelSlug: string;
		previousLatest: string;
		previousLastRunAt: string | null;
		requestedAt: number;
	}) {
		clearRunPoll();
		const stopAt = input.requestedAt + 45 * 60_000;
		const finishGraceMs = 90_000;
		let finishedAt: number | null = null;
		const poll = async () => {
			await loadBoard(true, true);
			const latest = posts.find((post) => post.channelSlug === input.channelSlug);
			const latestPostId = latest?.id ?? '';
			const updatedJob = jobs.find((job) => job.id === input.jobId) ?? null;
			const runError = effectiveRunError(updatedJob);
			const outcome = detectRunRequestOutcome({
				previousLatestPostId: input.previousLatest,
				currentLatestPostId: latestPostId,
				previousLastRunAt: input.previousLastRunAt,
				currentLastRunAt: updatedJob?.lastRunAt ?? null,
				currentLastStatus: updatedJob?.lastStatus ?? null,
				currentLastError: runError
			});

			if (outcome.kind === 'new-post' && latest) {
				selectedSlug = input.channelSlug;
				selectedPostId = latestPostId;
				notice = 'New report received.';
				clearRunPoll();
				return;
			}
			if (outcome.kind === 'run-finished') {
				if (outcome.failed) {
					const detail = runError ?? 'Unknown error';
					error = `Run failed: ${detail}`;
					clearRunPoll();
					return;
				}

				finishedAt ??= Date.now();
				if (Date.now() - finishedAt >= finishGraceMs) {
					notice = 'Run finished, but no new report was saved yet.';
					clearRunPoll();
					return;
				}
				notice = 'Run finished. Waiting for the report file to sync...';
				pollTimer = setTimeout(() => void poll(), 4000);
				return;
			}
			if (Date.now() >= stopAt) {
				const lastRun = updatedJob?.lastRunAt ? formatDate(updatedJob.lastRunAt) : 'No completed run yet';
				notice = `Run requested. Still waiting on Hermes. Last completed run: ${lastRun}.`;
				clearRunPoll();
				return;
			}
			const elapsedMs = Date.now() - input.requestedAt;
			const delayMs = elapsedMs < 5 * 60_000 ? 8000 : 15000;
			pollTimer = setTimeout(() => void poll(), delayMs);
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

	function formatElapsed(ms: number | null | undefined): string | null {
		if (!Number.isFinite(ms ?? Number.NaN)) return null;
		const totalSeconds = Math.max(0, Math.round((ms ?? 0) / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes <= 0) return `${seconds}s`;
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		if (hours <= 0) return `${minutes}m ${seconds}s`;
		return `${hours}h ${remainingMinutes}m`;
	}

	function statusLabel(channel: BoardChannel, job: HermesJob | null): string {
		if (!channel.active) return 'Archived';
		const activeRun = currentRunForJob(channel, job);
		if (activeRun) return runStatusLabel(activeRun);
		if (!job?.enabled || channel.state === 'paused') return 'Paused';
		if (channel.recentRun?.status) return runStatusLabel(channel.recentRun);
		if (job?.lastStatus && job.lastStatus !== 'ok') return 'Error';
		if (isQueued(job)) return 'Queued';
		return channel.state || 'Active';
	}

	function statusTone(
		channel: BoardChannel,
		job: HermesJob | null
	): 'ok' | 'warn' | 'error' | 'archived' | 'running' {
		if (!channel.active) return 'archived';
		const activeRun = currentRunForJob(channel, job);
		if (activeRun) return runStatusTone(activeRun);
		if (!job?.enabled || channel.state === 'paused') return 'warn';
		if (channel.recentRun?.status) return runStatusTone(channel.recentRun);
		if (job?.lastStatus && job.lastStatus !== 'ok') return 'error';
		if (isQueued(job)) return 'warn';
		return 'ok';
	}

	function isQueued(job: HermesJob | null): boolean {
		if (!job?.enabled || !job.nextRunAt) return false;
		const next = Date.parse(job.nextRunAt);
		if (!Number.isFinite(next)) return false;
		const last = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
		return next <= Date.now() + 60_000 && (!Number.isFinite(last) || last < next);
	}

	function currentRunForJob(channel: BoardChannel | null, job: HermesJob | null): HermesRun | null {
		if (!job) return null;
		if (isActiveRun(channel?.activeRun)) return channel.activeRun;
		const inline = (job as HermesJobWithRun).currentRun;
		if (isActiveRun(inline)) return inline;
		return runs.find((run) => run.jobId === job.id && isActiveRun(run)) ?? null;
	}

	function isActiveRun(run: HermesRun | null | undefined): run is HermesRun {
		if (!run) return false;
		const status = String(run.status ?? '').toLowerCase();
		if (['running', 'queued', 'pending', 'started', 'in_progress'].includes(status)) return true;
		if (['ok', 'error', 'failed', 'cancelled', 'canceled', 'complete', 'completed'].includes(status)) {
			return false;
		}
		return Boolean(run.startedAt || run.queuedAt) && !run.completedAt;
	}

	function runStartedAt(run: HermesRun | null): string | null {
		return run?.startedAt ?? run?.queuedAt ?? run?.updatedAt ?? null;
	}

	function runStatusLabel(run: HermesRun): string {
		const status = String(run.status ?? '').toLowerCase();
		if (['queued', 'pending'].includes(status)) return 'Queued';
		if (['running', 'started', 'in_progress'].includes(status)) return 'Running';
		if (['failed', 'error'].includes(status)) return 'Failed';
		if (['completed', 'complete', 'ok', 'success'].includes(status)) return 'Completed';
		if (['cancelled', 'canceled'].includes(status)) return 'Cancelled';
		return run.status || 'Active';
	}

	function runStatusTone(run: HermesRun): 'ok' | 'warn' | 'error' | 'running' {
		const status = String(run.status ?? '').toLowerCase();
		if (['running', 'started', 'in_progress'].includes(status)) return 'running';
		if (['queued', 'pending'].includes(status)) return 'warn';
		if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'error';
		return 'ok';
	}

	function reportUrl(post: BoardPost | null): string {
		if (!post || typeof window === 'undefined') return '';
		const url = new URL(window.location.href);
		url.pathname = '/board';
		url.searchParams.set('channel', post.channelSlug);
		url.searchParams.set('report', post.id);
		return url.toString();
	}

	function replaceReportUrl() {
		if (typeof window === 'undefined') return;
		const url = selectedPost ? reportUrl(selectedPost) : new URL('/board', window.location.href).toString();
		window.history.replaceState(null, '', url);
	}

	async function copyReportLink(post: BoardPost | null) {
		if (!post) return;
		const url = reportUrl(post);
		try {
			await navigator.clipboard.writeText(url);
			copiedReportId = post.id;
			clearCopiedTimer();
			copiedTimer = setTimeout(() => {
				copiedReportId = null;
				copiedTimer = null;
			}, 1800);
		} catch {
			notice = url;
		}
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
							class:channel-row--archived={!channel.active}
							onclick={() => selectChannel(channel)}
						>
							<span class="channel-row__main">
								<span class="channel-row__name">{channel.name}</span>
								<span class="channel-row__meta">
									{channel.postCount}
									{channel.postCount === 1 ? 'report' : 'reports'} · {relativeDate(channel.latestRunAt)}
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
								{#if !selectedChannel.active}
									<span>Archived output</span>
								{/if}
								{#if selectedRun}
									<span>Started: {relativeDate(runStartedAt(selectedRun))}</span>
								{/if}
								{#if formatElapsed(selectedRecentRun?.elapsedMs)}
									<span>Elapsed: {formatElapsed(selectedRecentRun?.elapsedMs)}</span>
								{/if}
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
										disabled={Boolean(actionBusy) || selectedJobRunning}
										onclick={() => jobAction('run')}
									>
										<Play size="13" strokeWidth={1.8} />
										{selectedJobRunning ? 'Running' : actionBusy === 'run' ? 'Starting' : 'Run now'}
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
							<div class="board__runs-head">
								<div>
									<div class="board__rail-title">Reports</div>
									<div class="board__runs-count">{selectedPosts.length} saved</div>
								</div>
								<div class="board__toggle" aria-label="Report list scope">
									<button
										type="button"
										class:board__toggle-button--active={reportScope === 'latest'}
										onclick={() => setReportScope('latest')}
									>
										Latest
									</button>
									<button
										type="button"
										class:board__toggle-button--active={reportScope === 'all'}
										onclick={() => setReportScope('all')}
									>
										All
									</button>
								</div>
							</div>
							{#if busy && selectedPosts.length === 0}
								<div class="board__empty">Fetching reports...</div>
							{:else}
								{#each visiblePosts as post (post.id)}
								<button
									type="button"
									class="run-row"
									class:run-row--active={selectedPost?.id === post.id}
									onclick={() => selectPost(post)}
								>
									<span class="run-row__top">
										<span class="run-row__time">{formatDate(post.runTime)}</span>
										{#if post.archived}
											<span class="run-row__chip">Archived</span>
										{/if}
									</span>
									<span class="run-row__preview">{post.preview || 'No response body captured.'}</span>
								</button>
								{:else}
									<div class="board__empty">
										{#if reportScope === 'latest'}
											No latest report for this channel yet.
										{:else}
											No saved reports for this channel yet.
										{/if}
									</div>
								{/each}
							{/if}
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
										{:else if selectedRecentRun?.status}
											<span>Status: {runStatusLabel(selectedRecentRun)}</span>
										{/if}
										{#if formatElapsed(selectedRecentRun?.elapsedMs)}
											<span>Elapsed: {formatElapsed(selectedRecentRun?.elapsedMs)}</span>
										{/if}
									</div>
									<div class="board__report-actions" aria-label="Report actions">
										<button
											type="button"
											class="btn btn--ghost"
											onclick={() => copyReportLink(selectedPost)}
										>
											{#if copiedReportId === selectedPost.id}
												<Check size="13" strokeWidth={1.8} />
												Copied link
											{:else}
												<Copy size="13" strokeWidth={1.8} />
												Copy link
											{/if}
										</button>
										<a class="btn btn--ghost" href={reportUrl(selectedPost)}>
											<ExternalLink size="13" strokeWidth={1.8} />
											Open report
										</a>
									</div>
								</header>
								{#if selectedRunError}
									<div class="board__notice board__notice--error">
										{selectedRunError}
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
	.channel-row--archived {
		color: var(--fg-2);
		background: color-mix(in srgb, var(--bg-raised) 54%, transparent);
	}
	.channel-row--archived .channel-row__name {
		font-weight: 600;
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
	.board-status--running {
		color: var(--status-verified-fg);
		background: color-mix(in srgb, var(--status-verified-bg) 72%, var(--bg-surface));
		border-color: color-mix(in srgb, var(--status-verified) 36%, var(--border-soft));
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
	.board__runs-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 2px;
	}
	.board__runs-count {
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.board__toggle {
		display: inline-flex;
		flex: 0 0 auto;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		padding: 2px;
	}
	.board__toggle button {
		border: 0;
		border-radius: var(--radius-1);
		background: transparent;
		color: var(--fg-3);
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 10.5px;
		line-height: 1.2;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 5px 7px;
	}
	.board__toggle button:hover,
	.board__toggle button:focus-visible,
	.board__toggle-button--active {
		background: var(--bg-raised);
		color: var(--fg-1);
		outline: none;
	}
	.run-row {
		display: grid;
		gap: 2px;
		padding: 8px;
		min-height: 58px;
	}
	.run-row__top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.run-row__time {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.run-row__chip {
		flex: 0 0 auto;
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.run-row__preview {
		font-size: 12px;
		line-height: 1.3;
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
	.board__report-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 7px;
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
		.board__actions :global(.btn),
		.board__report-actions,
		.board__report-actions :global(.btn) {
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
