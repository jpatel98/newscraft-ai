<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Markdown from '$lib/components/Markdown.svelte';
	import type { BoardChannel, BoardData, BoardPost, HermesJob, HermesRun } from '$lib/types';
	import { formatRelativeTime } from '$lib/utils/time';
	import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
	import Check from 'lucide-svelte/icons/check';
	import ChevronDown from 'lucide-svelte/icons/chevron-down';
	import Copy from 'lucide-svelte/icons/copy';
	import FileText from 'lucide-svelte/icons/file-text';
	import Hash from 'lucide-svelte/icons/hash';
	import Pause from 'lucide-svelte/icons/pause';
	import Play from 'lucide-svelte/icons/play';
	import Plus from 'lucide-svelte/icons/plus';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';

	type Tone = 'ok' | 'warn' | 'error' | 'archived' | 'running';
	type HermesJobWithRun = HermesJob & { currentRun?: HermesRun | null };

	let channels = $state<BoardChannel[]>([]);
	let posts = $state<BoardPost[]>([]);
	let jobs = $state<HermesJob[]>([]);
	let runs = $state<HermesRun[]>([]);
	let jobsError = $state<string | null>(null);
	let selectedSlug = $state('');
	let expandedPostId = $state('');
	let busy = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let actionBusy = $state<string | null>(null);
	let copiedPostId = $state<string | null>(null);
	let createOpen = $state(false);
	let createBusy = $state(false);
	let createName = $state('');
	let createSchedule = $state('');
	let createPrompt = $state('');
	let createDeliver = $state('');
	let focusedChannelView = $state(false);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedChannel = $derived(
		channels.find((channel) => channel.slug === selectedSlug) ?? channels[0] ?? null
	);
	const selectedPosts = $derived(
		selectedChannel ? posts.filter((post) => post.channelSlug === selectedChannel.slug) : []
	);
	const selectedJob = $derived(
		selectedChannel?.jobId ? jobs.find((job) => job.id === selectedChannel.jobId) ?? null : null
	);
	const selectedRun = $derived(currentRunForJob(selectedChannel, selectedJob));
	const selectedJobRunning = $derived(Boolean(selectedRun));
	const groupedPosts = $derived(groupPostsByDay(selectedPosts));

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		selectedSlug = params.get('channel') ?? '';
		expandedPostId = params.get('post') ?? '';
		createOpen = params.get('new') === '1';
		focusedChannelView = params.has('channel') && !createOpen;
		void loadChannels(true);
		return () => {
			clearRunPoll();
			clearCopiedTimer();
		};
	});

	async function loadChannels(preserveSelection = false, silent = false) {
		if (!silent) busy = true;
		error = null;
		try {
			const response = await fetch('/api/hermes/board', { cache: 'no-store' });
			if (!response.ok) throw new Error(`Channels ${response.status}`);
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
			if (!preserveSelection || !channelPosts.some((post) => post.id === expandedPostId)) {
				expandedPostId = channelPosts[0]?.id ?? '';
			}
			replaceChannelUrl();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			if (!silent) busy = false;
		}
	}

	function selectChannel(channel: BoardChannel) {
		focusedChannelView = true;
		createOpen = false;
		selectedSlug = channel.slug;
		expandedPostId = posts.find((post) => post.channelSlug === channel.slug)?.id ?? '';
		replaceChannelUrl();
	}

	function togglePost(post: BoardPost) {
		expandedPostId = expandedPostId === post.id ? '' : post.id;
		replaceChannelUrl();
	}

	function channelUrl(post: BoardPost | null): string {
		if (typeof window === 'undefined') return '';
		const url = new URL(window.location.href);
		url.pathname = '/channels';
		if (post) {
			url.searchParams.set('channel', post.channelSlug);
			url.searchParams.set('post', post.id);
		} else if (selectedChannel) {
			if (focusedChannelView) {
				url.searchParams.set('channel', selectedChannel.slug);
			} else {
				url.searchParams.delete('channel');
			}
			url.searchParams.delete('post');
		}
		url.searchParams.delete('new');
		url.searchParams.delete('report');
		return url.toString();
	}

	function replaceChannelUrl() {
		if (typeof window === 'undefined') return;
		const post = selectedPosts.find((candidate) => candidate.id === expandedPostId) ?? null;
		window.history.replaceState(null, '', channelUrl(post));
	}

	function openCreate() {
		createOpen = true;
		focusedChannelView = false;
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.pathname = '/channels';
		url.searchParams.set('new', '1');
		url.searchParams.delete('post');
		window.history.replaceState(null, '', url.toString());
	}

	function closeCreate() {
		createOpen = false;
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.searchParams.delete('new');
		window.history.replaceState(null, '', url.toString());
	}

	async function createChannel() {
		createBusy = true;
		error = null;
		notice = null;
		try {
			const response = await fetch('/api/hermes/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: createName,
					schedule: createSchedule,
					prompt: createPrompt,
					deliver: createDeliver
				})
			});
			if (!response.ok) throw new Error(await response.text());
			const data = (await response.json()) as { job?: HermesJob | null };
			await loadChannels(true, true);
			await invalidateAll();
			const job = data.job;
			const created = job
				? channels.find((channel) => channel.jobId === job.id) ??
					channels.find((channel) => channel.slug === channelSlugForJob(job.name, job.id))
				: null;
			if (created) selectChannel(created);
			createName = '';
			createSchedule = '';
			createPrompt = '';
			createDeliver = '';
			closeCreate();
			notice = 'Channel created.';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			createBusy = false;
		}
	}

	function onCreateSubmit(event: SubmitEvent) {
		event.preventDefault();
		void createChannel();
	}

	function channelSlugForJob(name: string, jobId: string): string {
		const base =
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.slice(0, 48) || 'channel';
		return `${base}-${jobId.slice(0, 8)}`;
	}

	async function copyPostLink(post: BoardPost) {
		try {
			await navigator.clipboard.writeText(channelUrl(post));
			copiedPostId = post.id;
			clearCopiedTimer();
			copiedTimer = setTimeout(() => {
				copiedPostId = null;
				copiedTimer = null;
			}, 1600);
		} catch {
			notice = channelUrl(post);
		}
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
				notice = `${jobName} run requested. Waiting for the next channel post...`;
				startRunPoll(channelSlug, previousLatest);
			} else {
				notice = `${jobName} ${action === 'pause' ? 'paused' : 'resumed'}.`;
			}
			await loadChannels(true, action === 'run');
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

	function startRunPoll(channelSlug: string, previousLatest: string) {
		clearRunPoll();
		const stopAt = Date.now() + 10 * 60_000;
		const poll = async () => {
			await loadChannels(true, true);
			const latest = posts.find((post) => post.channelSlug === channelSlug);
			if (latest && latest.id !== previousLatest) {
				selectedSlug = channelSlug;
				expandedPostId = latest.id;
				notice = 'New channel post received.';
				replaceChannelUrl();
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

	function formatTime(value: string | null | undefined): string {
		if (!value) return '—';
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
	}

	function relativeDate(value: string | null | undefined): string {
		if (!value) return 'No posts yet';
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

	function groupPostsByDay(items: BoardPost[]): { label: string; posts: BoardPost[] }[] {
		const groups = new Map<string, BoardPost[]>();
		for (const post of items) {
			const date = post.runTime ? new Date(post.runTime) : null;
			const key = date && Number.isFinite(date.getTime()) ? date.toDateString() : 'Undated';
			const rows = groups.get(key) ?? [];
			rows.push(post);
			groups.set(key, rows);
		}
		return Array.from(groups.entries()).map(([key, group]) => ({
			label: dayLabel(key),
			posts: group
		}));
	}

	function dayLabel(key: string): string {
		if (key === 'Undated') return key;
		const date = new Date(key);
		const today = new Date();
		const yesterday = new Date();
		yesterday.setDate(today.getDate() - 1);
		if (date.toDateString() === today.toDateString()) return 'Today';
		if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
		return new Intl.DateTimeFormat(undefined, {
			weekday: 'long',
			month: 'short',
			day: 'numeric'
		}).format(date);
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

	function statusTone(channel: BoardChannel, job: HermesJob | null): Tone {
		if (!channel.active) return 'archived';
		const activeRun = currentRunForJob(channel, job);
		if (activeRun) return runStatusTone(activeRun);
		if (!job?.enabled || channel.state === 'paused') return 'warn';
		if (channel.recentRun?.status) return runStatusTone(channel.recentRun);
		if (job?.lastStatus && job.lastStatus !== 'ok') return 'error';
		if (isQueued(job)) return 'warn';
		return 'ok';
	}

	function postTone(post: BoardPost): Tone {
		const status = String(post.runStatus ?? '').toLowerCase();
		if (['running', 'started', 'in_progress'].includes(status)) return 'running';
		if (['queued', 'pending'].includes(status)) return 'warn';
		if (['failed', 'error', 'cancelled', 'canceled'].includes(status) || post.lastError) return 'error';
		if (post.archived) return 'archived';
		return 'ok';
	}

	function postStatusLabel(post: BoardPost): string {
		if (post.runStatus) return runStatusLabel({ status: post.runStatus });
		if (post.archived) return 'Archived';
		return post.kind === 'run' ? 'Run event' : 'Completed';
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

	function runStatusLabel(run: Pick<HermesRun, 'status'>): string {
		const status = String(run.status ?? '').toLowerCase();
		if (['queued', 'pending'].includes(status)) return 'Queued';
		if (['running', 'started', 'in_progress'].includes(status)) return 'Running';
		if (['failed', 'error'].includes(status)) return 'Failed';
		if (['completed', 'complete', 'ok', 'success'].includes(status)) return 'Completed';
		if (['cancelled', 'canceled'].includes(status)) return 'Cancelled';
		return run.status || 'Active';
	}

	function runStatusTone(run: HermesRun): Tone {
		const status = String(run.status ?? '').toLowerCase();
		if (['running', 'started', 'in_progress'].includes(status)) return 'running';
		if (['queued', 'pending'].includes(status)) return 'warn';
		if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return 'error';
		return 'ok';
	}
</script>

<svelte:head>
	<title>{focusedChannelView && selectedChannel ? `${selectedChannel.name} · NewsCraft` : 'Channels · NewsCraft'}</title>
</svelte:head>

<div class="page">
	<div class="channels">
			<header class="channels__masthead">
				<div>
					<div class="channels__eyebrow">
						{focusedChannelView && selectedChannel ? 'Automated channel' : 'Newsroom channels'}
					</div>
					<h1 class="channels__title">
						{focusedChannelView && selectedChannel ? selectedChannel.name : 'Channels'}
					</h1>
					<p class="channels__intro">
						{#if focusedChannelView && selectedChannel}
							Reports, schedule, and run controls for this cron job.
						{:else}
							Scheduled reports land here as durable posts backed by VPS markdown files.
						{/if}
					</p>
				</div>
				<div class="channels__masthead-actions">
					<button type="button" class="btn btn--primary" onclick={openCreate}>
						<Plus size="14" strokeWidth={1.8} />
						New channel
					</button>
					<button type="button" class="btn btn--ghost" onclick={() => loadChannels(true)} disabled={busy}>
						<RefreshCw size="14" strokeWidth={1.7} />
						{busy ? 'Refreshing' : 'Refresh'}
					</button>
				</div>
			</header>

		{#if error}
			<div class="channels__notice channels__notice--error">{error}</div>
		{/if}
		{#if notice}
			<div class="channels__notice">{notice}</div>
		{/if}
			{#if jobsError}
				<div class="channels__notice">
					Saved posts loaded. Live channel controls are unavailable: {jobsError}
				</div>
			{/if}

			{#if createOpen}
				<form class="channels-create" onsubmit={onCreateSubmit}>
					<div class="channels-create__head">
						<div>
							<div class="channels__eyebrow">New automated channel</div>
							<h2 class="channels-create__title">Create channel</h2>
						</div>
						<button type="button" class="btn btn--ghost" onclick={closeCreate} disabled={createBusy}>
							Cancel
						</button>
					</div>
					<div class="channels-create__grid">
						<div class="field">
							<label class="field__label" for="channel-name">Name</label>
							<input
								id="channel-name"
								class="field__input"
								bind:value={createName}
								placeholder="News watch"
								required
							/>
						</div>
						<div class="field">
							<label class="field__label" for="channel-schedule">Schedule</label>
							<input
								id="channel-schedule"
								class="field__input"
								bind:value={createSchedule}
								placeholder="every 180m or 0 */3 * * *"
								required
							/>
						</div>
					</div>
					<div class="field">
						<label class="field__label" for="channel-prompt">Task prompt</label>
						<textarea
							id="channel-prompt"
							class="field__input channels-create__prompt"
							bind:value={createPrompt}
							placeholder="Scan the latest headlines and summarize what changed."
							required
						></textarea>
					</div>
					<div class="field">
						<label class="field__label" for="channel-deliver">Delivery target</label>
						<input
							id="channel-deliver"
							class="field__input"
							bind:value={createDeliver}
							placeholder="Optional"
						/>
					</div>
					<div class="channels-create__actions">
						<button type="submit" class="btn btn--primary" disabled={createBusy}>
							<Plus size="14" strokeWidth={1.8} />
							{createBusy ? 'Creating' : 'Create channel'}
						</button>
					</div>
				</form>
			{/if}

			<div class="channels__layout" class:channels__layout--focused={focusedChannelView}>
			{#if !focusedChannelView}
				<aside class="channels__rail" aria-label="Channels">
					<div class="channels__rail-title">Channels</div>
					{#if busy && channels.length === 0}
						<div class="channels__empty">Loading channels…</div>
					{:else}
						{#each channels as channel (channel.slug)}
							{@const job = jobs.find((candidate) => candidate.id === channel.jobId) ?? null}
							<button
								type="button"
								class="channel-feed-row"
								class:channel-feed-row--active={selectedChannel?.slug === channel.slug}
								class:channel-feed-row--archived={!channel.active}
								onclick={() => selectChannel(channel)}
							>
								<span class={`channel-feed-row__dot channel-feed-row__dot--${statusTone(channel, job)}`}></span>
								<span class="channel-feed-row__main">
									<span class="channel-feed-row__name"><Hash size="13" strokeWidth={1.7} />{channel.name}</span>
									<span class="channel-feed-row__meta">
										{channel.postCount} {channel.postCount === 1 ? 'post' : 'posts'} · {relativeDate(channel.latestRunAt)}
									</span>
								</span>
								<span class={`channels-status channels-status--${statusTone(channel, job)}`}>
									{statusLabel(channel, job)}
								</span>
							</button>
						{:else}
							<div class="channels__empty">No channel posts yet.</div>
						{/each}
					{/if}
				</aside>
			{/if}

			<section class="channels__main" aria-live="polite">
				{#if selectedChannel}
					<header class="channel-head">
						<div class="channel-head__title">
							<div class="channels__eyebrow">Channel</div>
							<h2><Hash size="18" strokeWidth={1.8} />{selectedChannel.name}</h2>
							<div class="channel-head__meta">
								<span class={`channels-status channels-status--${statusTone(selectedChannel, selectedJob)}`}>
									{statusLabel(selectedChannel, selectedJob)}
								</span>
								<span>{selectedChannel.postCount} posts</span>
								{#if selectedRun}
									<span>Started {relativeDate(runStartedAt(selectedRun))}</span>
								{/if}
								{#if formatElapsed(selectedRun?.elapsedMs ?? selectedChannel.recentRun?.elapsedMs)}
									<span>Elapsed {formatElapsed(selectedRun?.elapsedMs ?? selectedChannel.recentRun?.elapsedMs)}</span>
								{/if}
								{#if selectedJob?.scheduleDisplay}
									<span>{selectedJob.scheduleDisplay}</span>
								{/if}
								{#if selectedJob?.nextRunAt}
									<span>Next {formatDate(selectedJob.nextRunAt)}</span>
								{/if}
								{#if selectedJob?.lastRunAt}
									<span>Last {formatDate(selectedJob.lastRunAt)}</span>
								{/if}
								{#if !selectedChannel.active}
									<span>Archived output</span>
								{/if}
							</div>
						</div>

						{#if selectedJob}
							<div class="channel-head__actions" aria-label="Channel controls">
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
					</header>

					<div class="channel-detail" aria-label="Channel details">
						<div class="channel-detail__item">
							<span>Job</span>
							<strong>{selectedJob?.id ?? selectedChannel.jobId ?? selectedChannel.slug}</strong>
						</div>
						<div class="channel-detail__item">
							<span>Schedule</span>
							<strong>{selectedJob?.scheduleDisplay ?? selectedPosts[0]?.schedule ?? 'No schedule'}</strong>
						</div>
						<div class="channel-detail__item">
							<span>Next run</span>
							<strong>{formatDate(selectedJob?.nextRunAt)}</strong>
						</div>
						<div class="channel-detail__item">
							<span>Last run</span>
							<strong>{formatDate(selectedJob?.lastRunAt ?? selectedChannel.latestRunAt)}</strong>
						</div>
						<div class="channel-detail__item">
							<span>Delivery</span>
							<strong>{selectedJob?.deliver ?? 'Local archive'}</strong>
						</div>
					</div>

					<div class="channel-feed" aria-label="Channel posts">
						{#if busy && selectedPosts.length === 0}
							<div class="channels__empty channels__empty--panel">Fetching posts…</div>
						{:else if selectedPosts.length === 0}
							<div class="channels__empty channels__empty--panel">
								No reports have landed in this channel yet.
							</div>
						{:else}
							{#each groupedPosts as group (group.label)}
								<div class="channel-feed__day">{group.label}</div>
								{#each group.posts as post (post.id)}
									{@const expanded = expandedPostId === post.id}
									<article class="channel-post" class:channel-post--expanded={expanded}>
										<button
											type="button"
											class="channel-post__summary"
											aria-expanded={expanded}
											onclick={() => togglePost(post)}
										>
											<span class="channel-post__time">{formatTime(post.runTime)}</span>
											<span class="channel-post__body">
												<span class="channel-post__topline">
													<span class="channel-post__title">
														{post.kind === 'run' ? 'Run event' : 'Scheduled report'}
													</span>
													<span class={`channels-status channels-status--${postTone(post)}`}>
														{postStatusLabel(post)}
													</span>
													{#if formatElapsed(post.elapsedMs)}
														<span class="channel-post__elapsed">{formatElapsed(post.elapsedMs)}</span>
													{/if}
												</span>
												<span class="channel-post__preview">
													{post.preview || 'No response body captured.'}
												</span>
											</span>
											<ChevronDown
												class="channel-post__chev {expanded ? 'channel-post__chev--open' : ''}"
												size="14"
												strokeWidth={1.8}
											/>
										</button>

										{#if expanded}
											<div class="channel-post__expanded">
												<div class="channel-post__meta">
													<span>Job {post.jobId}</span>
													<span>{post.schedule || selectedJob?.scheduleDisplay || 'No schedule'}</span>
													{#if post.filePathDisplay}
														<span class="channel-post__file">
															<FileText size="12" strokeWidth={1.7} />
															Backed by {post.filePathDisplay}
														</span>
													{/if}
													{#if post.lastError}
														<span class="channel-post__error">
															<AlertTriangle size="12" strokeWidth={1.7} />
															{post.lastError}
														</span>
													{/if}
												</div>
												<div class="channel-post__actions" aria-label="Post actions">
													<button type="button" class="btn btn--ghost" onclick={() => copyPostLink(post)}>
														{#if copiedPostId === post.id}
															<Check size="13" strokeWidth={1.8} />
															Copied link
														{:else}
															<Copy size="13" strokeWidth={1.8} />
															Copy link
														{/if}
													</button>
												</div>
												<div class="channel-post__markdown">
													<Markdown content={post.responseMarkdown || '_No response body captured._'} />
												</div>
											</div>
										{/if}
									</article>
								{/each}
							{/each}
						{/if}
					</div>
				{:else}
					<div class="channels__empty channels__empty--panel">No channel posts yet.</div>
				{/if}
			</section>
		</div>
	</div>
</div>

<style>
	.channels {
		width: 100%;
		max-width: 1240px;
		margin: 0 auto;
		padding: 30px 28px 64px;
	}
		.channels__masthead {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 18px;
			margin-bottom: 18px;
		}
		.channels__masthead-actions {
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
			justify-content: flex-end;
		}
	.channels__eyebrow,
	.channels__rail-title {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.channels__title {
		font-family: var(--font-display);
		font-size: 34px;
		line-height: 1.02;
		letter-spacing: -0.028em;
		color: var(--fg-1);
		margin: 4px 0 0;
	}
	.channels__intro {
		margin: 8px 0 0;
		max-width: 560px;
		font-size: 14px;
		line-height: 1.5;
		color: var(--fg-2);
	}
	.channels__notice {
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
		.channels__notice--error {
			border-color: color-mix(in srgb, var(--flag-700) 24%, var(--border-soft));
			background: color-mix(in srgb, var(--flag-50) 36%, var(--bg-surface));
			color: var(--flag-700);
		}
		.channels-create {
			border: 1px solid var(--border-soft);
			background: var(--bg-surface);
			border-radius: var(--radius-2);
			padding: 16px;
			margin-bottom: 16px;
		}
		.channels-create__head {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px;
			margin-bottom: 14px;
		}
		.channels-create__title {
			margin: 3px 0 0;
			font-family: var(--font-display);
			font-size: 20px;
			line-height: 1.1;
			color: var(--fg-1);
			letter-spacing: 0;
		}
		.channels-create__grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
		}
		.channels-create__prompt {
			min-height: 112px;
			resize: vertical;
			line-height: 1.45;
		}
		.channels-create__actions {
			display: flex;
			justify-content: flex-end;
		}
		.channels__layout {
			display: grid;
			grid-template-columns: minmax(230px, 310px) minmax(0, 1fr);
		gap: 18px;
		align-items: start;
	}
	.channels__layout--focused {
		grid-template-columns: minmax(0, 1fr);
	}
	.channels__rail {
		min-width: 0;
		border-top: 1px solid var(--border-soft);
		padding-top: 10px;
		display: grid;
		gap: 5px;
	}
	.channel-feed-row {
		width: 100%;
		display: grid;
		grid-template-columns: 8px minmax(0, 1fr) auto;
		align-items: start;
		gap: 9px;
		padding: 10px;
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
	.channel-feed-row:hover,
	.channel-feed-row--active {
		background: var(--bg-surface);
		border-color: var(--border-soft);
	}
	.channel-feed-row--archived {
		color: var(--fg-2);
		background: color-mix(in srgb, var(--bg-raised) 50%, transparent);
	}
	.channel-feed-row:focus-visible,
	.channel-post__summary:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
	.channel-feed-row__dot {
		width: 7px;
		height: 7px;
		margin-top: 7px;
		border-radius: 999px;
		background: var(--fg-4);
	}
	.channel-feed-row__dot--ok {
		background: var(--status-verified);
	}
	.channel-feed-row__dot--warn {
		background: var(--status-review);
	}
	.channel-feed-row__dot--error {
		background: var(--status-breaking);
	}
	.channel-feed-row__dot--running {
		background: var(--cobalt-500);
	}
	.channel-feed-row__main {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.channel-feed-row__name {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 700;
		letter-spacing: -0.012em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.channel-feed-row__meta {
		font-size: 12px;
		color: var(--fg-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.channels-status {
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
	.channels-status--ok {
		color: var(--status-verified-fg);
		background: var(--status-verified-bg);
		border-color: color-mix(in srgb, var(--status-verified) 18%, var(--border-soft));
	}
	.channels-status--warn {
		color: var(--status-review-fg);
		background: var(--status-review-bg);
		border-color: color-mix(in srgb, var(--status-review) 24%, var(--border-soft));
	}
	.channels-status--error {
		color: var(--status-breaking-fg);
		background: var(--status-breaking-bg);
		border-color: color-mix(in srgb, var(--status-breaking) 24%, var(--border-soft));
	}
	.channels-status--running {
		color: var(--accent-fg);
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 32%, var(--border-soft));
	}
	.channels-status--archived {
		color: var(--fg-3);
		background: var(--bg-raised);
	}
	.channels__main {
		min-width: 0;
		border-top: 1px solid var(--border-soft);
		padding-top: 14px;
	}
	.channel-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 18px;
	}
	.channel-head h2 {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-display);
		font-size: 26px;
		margin: 3px 0 0;
		color: var(--fg-1);
		letter-spacing: -0.018em;
		line-height: 1.15;
	}
	.channel-head__meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 7px;
		margin-top: 8px;
		color: var(--fg-3);
	}
	.channel-head__meta span:not(.channels-status),
	.channel-post__meta span,
	.channel-post__elapsed {
		font-family: var(--font-mono);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.channel-head__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 7px;
	}
	.channel-detail {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 1px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--border-soft);
		overflow: hidden;
		margin-bottom: 18px;
	}
	.channel-detail__item {
		min-width: 0;
		background: var(--bg-surface);
		padding: 11px 12px;
		display: grid;
		gap: 4px;
	}
	.channel-detail__item span {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--fg-3);
	}
	.channel-detail__item strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		color: var(--fg-1);
	}
	.channel-feed {
		display: grid;
		gap: 4px;
	}
	.channel-feed__day {
		position: sticky;
		top: 0;
		z-index: 1;
		margin: 12px 0 6px;
		padding: 5px 0;
		background: var(--bg-page);
		border-bottom: 1px solid var(--border-soft);
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.channel-post {
		border: 1px solid transparent;
		border-radius: var(--radius-2);
		background: transparent;
		overflow: hidden;
	}
	.channel-post:hover,
	.channel-post--expanded {
		border-color: var(--border-soft);
		background: var(--bg-surface);
	}
	.channel-post__summary {
		width: 100%;
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr) 20px;
		gap: 12px;
		align-items: start;
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--fg-1);
		text-align: left;
		cursor: pointer;
	}
	.channel-post__time {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-3);
		padding-top: 2px;
	}
	.channel-post__body {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.channel-post__topline {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 7px;
	}
	.channel-post__title {
		font-family: var(--font-display);
		font-size: 14.5px;
		font-weight: 700;
		letter-spacing: -0.012em;
		color: var(--fg-1);
	}
	.channel-post__preview {
		font-size: 13px;
		line-height: 1.4;
		color: var(--fg-2);
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.channel-post__chev {
		color: var(--fg-3);
		margin-top: 2px;
		transition: transform var(--dur-fast) var(--ease-std);
	}
	.channel-post__chev--open {
		transform: rotate(180deg);
	}
	.channel-post__expanded {
		padding: 0 12px 14px 82px;
	}
	.channel-post__meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		color: var(--fg-3);
		margin-bottom: 10px;
	}
	.channel-post__file,
	.channel-post__error {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.channel-post__error {
		color: var(--status-breaking-fg);
	}
	.channel-post__actions {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 10px;
	}
	.channel-post__markdown {
		border-top: 1px solid var(--border-soft);
		padding-top: 14px;
	}
	.channels__empty {
		padding: 12px 10px;
		color: var(--fg-3);
		font-size: 13px;
	}
	.channels__empty--panel {
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
		border-radius: var(--radius-2);
		padding: 24px;
	}
	@media (prefers-color-scheme: dark) {
		.channels__notice--error {
			background: color-mix(in srgb, var(--flag-700) 14%, var(--bg-surface));
			color: var(--flag-300);
		}
	}
		@media (max-width: 960px) {
			.channels__layout {
				grid-template-columns: 1fr;
			}
			.channel-detail {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
			.channels-create__grid {
				grid-template-columns: 1fr;
			}
			.channels__rail {
				position: static;
			}
	}
	@media (max-width: 620px) {
		.channels {
			padding: 24px 16px 52px;
		}
		.channels__masthead,
		.channel-head {
			flex-direction: column;
		}
			.channel-head__actions,
			.channels__masthead-actions,
			.channel-head__actions :global(.btn) {
				width: 100%;
			}
		.channel-post__summary {
			grid-template-columns: 48px minmax(0, 1fr) 18px;
			gap: 9px;
			padding: 10px;
		}
			.channel-post__expanded {
				padding: 0 10px 12px 67px;
			}
			.channel-detail {
				grid-template-columns: 1fr;
			}
			.channels__title {
				font-size: 30px;
			}
	}
</style>
