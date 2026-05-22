<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import type { BoardChannel, BoardData, BoardPost, ChannelSource, HermesJob, HermesRun } from '$lib/types';
	import { detectRunRequestOutcome } from '$lib/utils/run-poll';
	import { effectiveRunError } from '$lib/utils/cron-delivery';
	import { formatRelativeTime } from '$lib/utils/time';
	import Hash from 'lucide-svelte/icons/hash';
	import Pause from 'lucide-svelte/icons/pause';
	import Pencil from 'lucide-svelte/icons/pencil';
	import Play from 'lucide-svelte/icons/play';
	import Plus from 'lucide-svelte/icons/plus';
	import RefreshCw from 'lucide-svelte/icons/refresh-cw';
	import Trash2 from 'lucide-svelte/icons/trash-2';

	type Tone = 'ok' | 'warn' | 'error' | 'archived' | 'running';
	type HermesJobWithRun = HermesJob & { currentRun?: HermesRun | null };
	type RunWatchStatus =
		| 'requested'
		| 'queued'
		| 'running'
		| 'finishing'
		| 'output-saved'
		| 'failed'
		| 'finished-no-output'
		| 'timeout';

	interface RunWatchState {
		jobId: string;
		channelSlug: string;
		requestedAt: number;
		status: RunWatchStatus;
		lastCheckedAt: number | null;
		message: string;
		detail: string | null;
		latestPostId: string | null;
	}

	let channels = $state<BoardChannel[]>([]);
	let posts = $state<BoardPost[]>([]);
	let jobs = $state<HermesJob[]>([]);
	let runs = $state<HermesRun[]>([]);
	let jobsError = $state<string | null>(null);
	let selectedSlug = $state('');
	let busy = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let noticeChannelSlug = $state<string | null>(null);
	let actionBusy = $state<string | null>(null);
	let createOpen = $state(false);
	let formMode = $state<'create' | 'edit'>('create');
	let editJobId = $state('');
	let createBusy = $state(false);
	let createName = $state('');
	let createDescription = $state('');
	let createSchedule = $state('');
	let createPrompt = $state('');
	let createDeliver = $state('database');
	let createOutputFormat = $state('markdown');
	let createSources = $state<ChannelSource[]>([]);
	let focusedChannelView = $state(false);
	let renameOpen = $state(false);
	let renameDraft = $state('');
	let renameBusy = $state(false);
	let runWatch = $state<RunWatchState | null>(null);
	let runWatchNow = $state(Date.now());
	let expandedOutputPostId = $state<string | null>(null);
	let outputMarkdownById = $state<Record<string, string>>({});
	let outputLoadingId = $state<string | null>(null);
	let outputLoadError = $state<string | null>(null);
	let hasInitialLoad = $state(false);
	let lastRouteRefreshKey = $state('');
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let runWatchTicker: ReturnType<typeof setInterval> | null = null;
	let silentRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let loadSeq = 0;

	const selectedChannel = $derived(
		channels.find((channel) => channel.slug === selectedSlug) ?? channels[0] ?? null
	);
	const selectedPosts = $derived(
		selectedChannel ? posts.filter((post) => post.channelSlug === selectedChannel.slug) : []
	);
	const selectedJob = $derived(
		selectedChannel?.jobId ? jobs.find((job) => job.id === selectedChannel.jobId) ?? null : null
	);
	const selectedSources = $derived(
		[...(selectedJob?.sources ?? [])]
			.filter((source) => source.enabled !== false)
			.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
	);
	const selectedRun = $derived(currentRunForJob(selectedChannel, selectedJob));
	const selectedJobRunning = $derived(Boolean(selectedRun));
	const selectedRunHistory = $derived(
		selectedJob ? runs.filter((run) => run.jobId === selectedJob.id) : []
	);
	const selectedProgressRun = $derived(selectedRun ?? selectedRunHistory[0] ?? selectedChannel?.recentRun ?? null);
	const selectedProgressItems = $derived(progressItems(selectedProgressRun));
	const latestPost = $derived(selectedPosts[0] ?? null);
	const latestOutputMarkdown = $derived(
		latestPost ? latestPost.responseMarkdown || outputMarkdownById[latestPost.id] || '' : ''
	);
	const latestOutputExpanded = $derived(Boolean(latestPost && expandedOutputPostId === latestPost.id));
	const runWatchVisible = $derived(
		Boolean(runWatch && selectedChannel && runWatch.channelSlug === selectedChannel.slug)
	);
	const runWatchElapsed = $derived(
		runWatch ? formatElapsed(Math.max(0, runWatchNow - runWatch.requestedAt)) : null
	);
	const visibleNotice = $derived(
		notice && (!noticeChannelSlug || noticeChannelSlug === selectedChannel?.slug) ? notice : null
	);

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		lastRouteRefreshKey = routeRefreshKey(params);
		applyQueryState(params);
		void loadChannels(true).finally(() => {
			hasInitialLoad = true;
		});
		silentRefreshTimer = setInterval(() => {
			if (createOpen || renameOpen) return;
			if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
			void loadChannels(true, true);
		}, 15_000);
		return () => {
			clearRunPoll();
			stopRunWatchTicker();
			if (silentRefreshTimer) clearInterval(silentRefreshTimer);
		};
	});

	$effect(() => {
		const params = new URLSearchParams(page.url.search);
		untrack(() => applyQueryState(params, true));
		const nextKey = routeRefreshKey(params);
		if (!hasInitialLoad) {
			lastRouteRefreshKey = nextKey;
			return;
		}
		if (nextKey === lastRouteRefreshKey) return;
		lastRouteRefreshKey = nextKey;
		void loadChannels(true, true);
	});

	function routeRefreshKey(params: URLSearchParams): string {
		return `${params.get('mission') ?? params.get('channel') ?? ''}|${params.get('report') ?? params.get('post') ?? ''}|${params.get('new') ?? ''}|${params.get('rename') ?? ''}|${params.get('edit') ?? ''}`;
	}

	async function loadChannels(preserveSelection = false, silent = false) {
		if (!silent) {
			busy = true;
			error = null;
		}
		const seq = ++loadSeq;
		try {
			const response = await fetch('/api/hermes/board', { cache: 'no-store' });
			if (!response.ok) throw new Error(`Missions ${response.status}`);
			const data = (await response.json()) as BoardData;
			if (seq !== loadSeq) return;
			channels = data.channels ?? [];
			posts = data.posts ?? [];
			jobs = data.jobs ?? [];
			runs = data.runs ?? [];
			jobsError = data.jobsError ?? null;

			if (!preserveSelection || !channels.some((channel) => channel.slug === selectedSlug)) {
				selectedSlug = channels[0]?.slug ?? '';
			}
			if (typeof window !== 'undefined') {
				applyQueryState(new URLSearchParams(window.location.search), true);
			}
			if (!createOpen && !renameOpen) replaceChannelUrl();
		} catch (err) {
			if (seq !== loadSeq) return;
			if (!silent) error = err instanceof Error ? err.message : String(err);
		} finally {
			if (!silent) busy = false;
		}
	}

	async function handleLatestOutputToggle(event: Event, post: BoardPost) {
		const open = (event.currentTarget as HTMLDetailsElement).open;
		if (!open) {
			if (expandedOutputPostId === post.id) expandedOutputPostId = null;
			return;
		}

		expandedOutputPostId = post.id;
		outputLoadError = null;
		if (post.responseMarkdown || outputMarkdownById[post.id] || outputLoadingId === post.id) return;

		outputLoadingId = post.id;
		try {
			const response = await fetch(`/api/hermes/reports/${encodeURIComponent(post.id)}`, {
				cache: 'no-store'
			});
			if (!response.ok) throw new Error(`Report ${response.status}`);
			const data = (await response.json()) as { responseMarkdown?: unknown };
			const markdown = typeof data.responseMarkdown === 'string' ? data.responseMarkdown : '';
			outputMarkdownById = { ...outputMarkdownById, [post.id]: markdown };
		} catch (err) {
			if (expandedOutputPostId === post.id) {
				outputLoadError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			if (outputLoadingId === post.id) outputLoadingId = null;
		}
	}

	function selectChannel(channel: BoardChannel) {
		focusedChannelView = true;
		createOpen = false;
		selectedSlug = channel.slug;
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.pathname = '/missions';
		url.searchParams.set('mission', channel.slug);
		url.searchParams.delete('report');
		url.searchParams.delete('post');
		url.searchParams.delete('new');
		url.searchParams.delete('edit');
		url.searchParams.delete('rename');
		void goto(url.toString(), { replaceState: true, noScroll: true, keepFocus: true });
	}

	function replaceChannelUrl() {
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.pathname = '/missions';
		if (selectedChannel && focusedChannelView) {
			url.searchParams.set('mission', selectedChannel.slug);
		} else {
			url.searchParams.delete('mission');
			url.searchParams.delete('channel');
		}
		url.searchParams.delete('report');
		url.searchParams.delete('post');
		url.searchParams.delete('new');
		url.searchParams.delete('edit');
		url.searchParams.delete('rename');
		replaceState(url.toString(), page.state);
	}

	function openCreate() {
		formMode = 'create';
		editJobId = '';
		createOpen = true;
		focusedChannelView = false;
		createName = '';
		createDescription = '';
		createSchedule = '';
		createPrompt = '';
		createDeliver = 'database';
		createOutputFormat = 'markdown';
		createSources = [];
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.pathname = '/missions';
		url.searchParams.set('new', '1');
		url.searchParams.delete('edit');
		url.searchParams.delete('rename');
		url.searchParams.delete('report');
		url.searchParams.delete('post');
		replaceState(url.toString(), page.state);
	}

	function hydrateEditForm(job: HermesJob, channel: BoardChannel | null, targetPosts: BoardPost[]) {
		formMode = 'edit';
		editJobId = job.id;
		createName = job.name || channel?.name || '';
		createDescription = job.description ?? '';
		createSchedule = job.scheduleDisplay || targetPosts[0]?.schedule || '';
		createPrompt = job.prompt ?? '';
		createDeliver = job.deliver || 'database';
		createOutputFormat = job.outputFormat || 'markdown';
		createSources = cloneSources(job.sources);
	}

	function openEdit() {
		if (!selectedJob) return;
		hydrateEditForm(selectedJob, selectedChannel, selectedPosts);
		createOpen = true;
		focusedChannelView = false;
		renameOpen = false;
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.pathname = '/missions';
		if (selectedChannel) url.searchParams.set('mission', selectedChannel.slug);
		url.searchParams.set('edit', '1');
		url.searchParams.delete('new');
		url.searchParams.delete('rename');
		url.searchParams.delete('report');
		url.searchParams.delete('post');
		replaceState(url.toString(), page.state);
	}

	function sourceDraftId(): string {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
		return `source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}

	function emptySource(sortOrder = createSources.length): ChannelSource {
		return {
			id: sourceDraftId(),
			type: 'url',
			name: '',
			url: '',
			enabled: true,
			sortOrder
		};
	}

	function cloneSources(sources: ChannelSource[] | undefined): ChannelSource[] {
		return (sources ?? []).map((source, index) => ({
			id: source.id || sourceDraftId(),
			type: 'url',
			name: source.name,
			url: source.url,
			enabled: source.enabled !== false,
			sortOrder: index
		}));
	}

	function sourcePayload(): ChannelSource[] {
		return createSources.map((source, index) => ({
			...source,
			type: 'url',
			enabled: source.enabled !== false,
			sortOrder: index
		}));
	}

	function addSource() {
		createSources = [...createSources, emptySource()];
	}

	function updateSource(index: number, field: 'name' | 'url', value: string) {
		createSources = createSources.map((source, sourceIndex) =>
			sourceIndex === index ? { ...source, [field]: value } : source
		);
	}

	function removeSource(index: number) {
		createSources = createSources
			.filter((_, sourceIndex) => sourceIndex !== index)
			.map((source, sortOrder) => ({ ...source, sortOrder }));
	}

	function cancelRenameTitle() {
		renameOpen = false;
		renameDraft = '';
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.searchParams.delete('rename');
		replaceState(url.toString(), page.state);
	}

	function onRenameSubmit(event: SubmitEvent) {
		event.preventDefault();
		void saveChannelTitle();
	}

	function closeCreate() {
		createOpen = false;
		formMode = 'create';
		editJobId = '';
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		url.searchParams.delete('new');
		url.searchParams.delete('edit');
		url.searchParams.delete('rename');
		replaceState(url.toString(), page.state);
	}

	async function createChannel() {
		createBusy = true;
		error = null;
		notice = null;
		noticeChannelSlug = null;
		try {
			const response = await fetch('/api/hermes/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: createName,
					description: createDescription,
					schedule: createSchedule,
					prompt: createPrompt,
					deliver: createDeliver,
					outputFormat: createOutputFormat,
					sources: sourcePayload()
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
			createDescription = '';
			createSchedule = '';
			createPrompt = '';
			createDeliver = 'database';
			createOutputFormat = 'markdown';
			createSources = [];
			closeCreate();
			notice = 'Mission created.';
			noticeChannelSlug = null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			createBusy = false;
		}
	}

	function onCreateSubmit(event: SubmitEvent) {
		event.preventDefault();
		void submitChannelForm();
	}

	async function submitChannelForm() {
		if (formMode === 'edit') {
			await updateChannel();
			return;
		}
		await createChannel();
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
		noticeChannelSlug = null;
		try {
			const response = await fetch(
				`/api/hermes/jobs/${encodeURIComponent(selectedJob.id)}/${action}`,
				{ method: 'POST' }
			);
			if (!response.ok) throw new Error(await response.text());
			if (action === 'run') {
				runWatch = {
					jobId: selectedJob.id,
					channelSlug,
					requestedAt,
					status: 'requested',
					lastCheckedAt: null,
					message: `Run request sent for ${jobName}. Waiting for the mission runner...`,
					detail: null,
					latestPostId: null
				};
				startRunWatchTicker();
				notice = `${jobName} run requested.`;
				noticeChannelSlug = channelSlug || null;
				startRunPoll({
					jobId: selectedJob.id,
					channelSlug,
					previousLatest,
					previousLastRunAt,
					requestedAt
				});
			} else {
				notice = `${jobName} ${action === 'pause' ? 'paused' : 'resumed'}.`;
				noticeChannelSlug = channelSlug || null;
			}
			await loadChannels(true, action === 'run');
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			actionBusy = null;
		}
	}

	async function updateChannel() {
		if (!editJobId) return;
		createBusy = true;
		actionBusy = 'edit';
		error = null;
		notice = null;
		noticeChannelSlug = null;
		try {
			const response = await fetch(`/api/hermes/jobs/${encodeURIComponent(editJobId)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: createName,
					description: createDescription,
					schedule: createSchedule,
					prompt: createPrompt,
					deliver: createDeliver,
					outputFormat: createOutputFormat,
					sources: sourcePayload()
				})
			});
			if (!response.ok) throw new Error(await response.text());
			const data = (await response.json()) as { job?: HermesJob | null };
			await loadChannels(true, true);
			await invalidateAll();
			const updated = data.job ? channels.find((channel) => channel.jobId === data.job?.id) ?? null : null;
			if (updated) selectChannel(updated);
			closeCreate();
			notice = 'Mission updated.';
			noticeChannelSlug = null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			createBusy = false;
			actionBusy = null;
		}
	}

	async function deleteSelectedMission() {
		if (!selectedJob) return;
		const name = selectedJob.name || selectedChannel?.name || 'this mission';
		if (typeof window !== 'undefined' && !window.confirm(`Delete "${name}" and its saved outputs?`)) return;
		actionBusy = 'delete';
		error = null;
		notice = null;
		noticeChannelSlug = null;
		try {
			const response = await fetch(`/api/hermes/channels/${encodeURIComponent(selectedJob.id)}`, {
				method: 'DELETE'
			});
			if (!response.ok) throw new Error(await response.text());
			await loadChannels(false, true);
			await invalidateAll();
			focusedChannelView = false;
			createOpen = false;
			renameOpen = false;
			notice = 'Mission deleted.';
			noticeChannelSlug = null;
			if (typeof window !== 'undefined') {
				const url = new URL(window.location.href);
				url.pathname = '/missions';
				url.search = '';
				replaceState(url.toString(), page.state);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			actionBusy = null;
		}
	}

	async function saveChannelTitle() {
		if (!selectedJob) return;
		const next = renameDraft.trim();
		if (!next) {
			error = 'Mission name is required.';
			return;
		}
		renameBusy = true;
		error = null;
		notice = null;
		noticeChannelSlug = null;
		try {
			const response = await fetch(`/api/hermes/jobs/${encodeURIComponent(selectedJob.id)}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: next })
			});
			if (!response.ok) throw new Error(await response.text());
			const data = (await response.json()) as { job?: HermesJob | null };
			await loadChannels(true, true);
			await invalidateAll();
			const updated = data.job ? channels.find((channel) => channel.jobId === data.job?.id) ?? null : null;
			if (updated) selectChannel(updated);
			renameOpen = false;
			renameDraft = '';
			if (typeof window !== 'undefined') {
				const url = new URL(window.location.href);
				url.searchParams.delete('rename');
				replaceState(url.toString(), page.state);
			}
			notice = 'Mission name updated.';
			noticeChannelSlug = selectedChannel?.slug ?? null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			renameBusy = false;
		}
	}

	function applyQueryState(params: URLSearchParams, preserveSelection = false) {
		const channel = params.get('mission') ?? params.get('channel') ?? '';
		const newOpen = params.get('new') === '1';
		const editOpen = params.get('edit') === '1';
		const formOpen = newOpen || editOpen;
		const renameRequested = params.get('rename') === '1';
		const channelSlug = channel || selectedSlug;
		const targetChannel = channels.find((candidate) => candidate.slug === channelSlug) ?? null;
		const targetJob = targetChannel?.jobId
			? jobs.find((candidate) => candidate.id === targetChannel.jobId) ?? null
			: null;
		const targetPosts = targetChannel
			? posts.filter((candidate) => candidate.channelSlug === targetChannel.slug)
			: [];
		const wasFormOpen = createOpen;
		const previousMode = formMode;
		const previousEditJobId = editJobId;
		createOpen = formOpen;
		const shouldHydrateForm =
			!preserveSelection ||
			!wasFormOpen ||
			(editOpen && targetJob && (previousMode !== 'edit' || previousEditJobId !== targetJob.id)) ||
			(!editOpen && previousMode !== 'create');
		if (formOpen && !createBusy && shouldHydrateForm) {
			if (editOpen && targetJob) {
				hydrateEditForm(targetJob, targetChannel, targetPosts);
			} else if (editOpen) {
				formMode = 'edit';
				editJobId = '';
				createName = '';
				createDescription = '';
				createSchedule = '';
				createPrompt = '';
				createDeliver = 'database';
				createOutputFormat = 'markdown';
				createSources = [];
			} else {
				formMode = 'create';
				editJobId = '';
				createName = '';
				createDescription = '';
				createSchedule = '';
				createPrompt = '';
				createDeliver = 'database';
				createOutputFormat = 'markdown';
				createSources = [];
			}
		}
		if (renameRequested && !formOpen && targetJob) {
			const wasClosed = !renameOpen;
			renameOpen = true;
			if (!preserveSelection || wasClosed) {
				renameDraft = targetJob.name || targetChannel?.name || '';
			}
		} else if (!renameRequested) {
			renameOpen = false;
		} else if (!targetJob) {
			renameOpen = false;
		}
		focusedChannelView = (params.has('mission') || params.has('channel')) && !formOpen;
		if (channel) selectedSlug = channel;
	}

	function clearRunPoll() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
	}

	function startRunWatchTicker() {
		if (runWatchTicker) return;
		runWatchNow = Date.now();
		runWatchTicker = setInterval(() => {
			runWatchNow = Date.now();
		}, 1000);
	}

	function stopRunWatchTicker() {
		if (!runWatchTicker) return;
		clearInterval(runWatchTicker);
		runWatchTicker = null;
	}

	function dismissRunWatch() {
		runWatch = null;
		if (!pollTimer) stopRunWatchTicker();
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
			await loadChannels(true, true);
			const latest = posts.find((post) => post.channelSlug === input.channelSlug);
			const latestPostId = latest?.id ?? '';
			const updatedJob = jobs.find((job) => job.id === input.jobId) ?? null;
			const activeRun = runs.find((run) => run.jobId === input.jobId && isActiveRun(run)) ?? null;
			const activeStatus = String(activeRun?.status ?? '').toLowerCase();
			if (runWatch && runWatch.jobId === input.jobId) {
				runWatch = {
					...runWatch,
					lastCheckedAt: Date.now(),
					status: activeStatus === 'queued' ? 'queued' : activeRun ? 'running' : runWatch.status,
					message:
						activeStatus === 'queued'
							? 'Run is queued.'
							: activeRun
								? 'Run is currently executing.'
								: runWatch.message
				};
			}
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
				if (runWatch && runWatch.jobId === input.jobId) {
					runWatch = {
						...runWatch,
						status: 'output-saved',
						lastCheckedAt: Date.now(),
						message: 'Run completed and output was saved.',
						detail: null,
						latestPostId
					};
				}
				notice = 'Mission run completed.';
				noticeChannelSlug = input.channelSlug;
				replaceChannelUrl();
				clearRunPoll();
				stopRunWatchTicker();
				return;
			}
			if (outcome.kind === 'run-finished') {
				if (outcome.failed) {
					const detail = runError ?? 'Unknown error';
					if (runWatch && runWatch.jobId === input.jobId) {
						runWatch = {
							...runWatch,
							status: 'failed',
							lastCheckedAt: Date.now(),
							message: 'Run finished with an error.',
							detail,
							latestPostId: null
						};
					}
					error = `Run failed: ${detail}`;
					clearRunPoll();
					stopRunWatchTicker();
					return;
				}

				finishedAt ??= Date.now();
				if (runWatch && runWatch.jobId === input.jobId) {
					runWatch = {
						...runWatch,
						status: 'finishing',
						lastCheckedAt: Date.now(),
						message: 'Run finished. Waiting for the saved output to sync...',
						detail: null,
						latestPostId: null
					};
				}

				if (Date.now() - finishedAt >= finishGraceMs) {
					if (runWatch && runWatch.jobId === input.jobId) {
						runWatch = {
							...runWatch,
							status: 'finished-no-output',
							lastCheckedAt: Date.now(),
							message: 'Run finished, but no new output was saved.',
							detail: null,
							latestPostId: null
						};
					}
					notice = 'Run finished, but no new mission output was saved yet.';
					noticeChannelSlug = input.channelSlug;
					clearRunPoll();
					stopRunWatchTicker();
					return;
				}
				pollTimer = setTimeout(() => void poll(), 4000);
				return;
			}
			if (Date.now() >= stopAt) {
				const lastRun = updatedJob?.lastRunAt ? formatDate(updatedJob.lastRunAt) : 'No completed run yet';
				if (runWatch && runWatch.jobId === input.jobId) {
					runWatch = {
						...runWatch,
						status: 'timeout',
						lastCheckedAt: Date.now(),
						message: 'Still waiting for completion.',
						detail: `Last completed run: ${lastRun}.`,
						latestPostId: null
					};
				}
				notice = `Run requested. Still waiting on completion. Last completed run: ${lastRun}.`;
				noticeChannelSlug = input.channelSlug;
				clearRunPoll();
				stopRunWatchTicker();
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

	function sourceHost(url: string): string {
		try {
			const parsed = new URL(url);
			return parsed.hostname.replace(/^www\./, '') || url;
		} catch {
			return url;
		}
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

	function progressItems(run: HermesRun | null) {
		if (!run) return [];
		const steps =
			run.steps?.map((step) => ({
				id: `step:${step.id}`,
				label: step.label,
				status: step.status,
				time: step.completedAt ?? step.startedAt ?? run.latestActivityAt ?? run.updatedAt ?? null,
				tone: progressTone(step.status),
				detail: null
			})) ?? [];
		const tools =
			run.toolCalls?.map((call) => ({
				id: `tool:${call.id}`,
				label: toolLabel(call.name),
				status: call.status,
				time: call.completedAt ?? call.startedAt ?? run.latestActivityAt ?? run.updatedAt ?? null,
				tone: progressTone(call.status),
				detail: call.error
			})) ?? [];
		return [...steps, ...tools]
			.sort((left, right) => timeValue(left.time) - timeValue(right.time))
			.slice(-10);
	}

	function timeValue(value: string | null | undefined): number {
		const parsed = value ? Date.parse(value) : Number.NaN;
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function progressTone(status: string): Tone {
		const normalized = status.toLowerCase();
		if (['running', 'started', 'in_progress'].includes(normalized)) return 'running';
		if (['queued', 'pending'].includes(normalized)) return 'warn';
		if (['failed', 'error', 'blocked', 'unavailable', 'cancelled', 'canceled'].includes(normalized)) return 'error';
		return 'ok';
	}

	function toolLabel(name: string): string {
		return name
			.replace(/_/g, ' ')
			.replace(/\b\w/g, (char) => char.toUpperCase())
			.trim();
	}

	function progressStatusLabel(status: string): string {
		return runStatusLabel({ status });
	}

	function latestRunActivity(run: HermesRun | null): string | null {
		return run?.latestActivityAt ?? run?.updatedAt ?? run?.completedAt ?? run?.startedAt ?? run?.queuedAt ?? null;
	}

	function missionActivityAt(
		channel: BoardChannel | null,
		job: HermesJob | null,
		run: HermesRun | null
	): string | null {
		return latestRunActivity(run) ?? channel?.latestRunAt ?? job?.lastRunAt ?? null;
	}

	function statusLabel(channel: BoardChannel, job: HermesJob | null): string {
		if (!channel.active) return 'Archived';
		const activeRun = currentRunForJob(channel, job);
		if (activeRun) return runStatusLabel(activeRun);
		if (!job) return channel.state === 'saved' ? 'Saved' : channel.state || 'Unavailable';
		if (!job?.enabled || channel.state === 'paused') return 'Paused';
		if (channel.recentRun?.status) return runStatusLabel(channel.recentRun);
		if (isErrorStatus(job?.lastStatus)) return 'Error';
		if (isQueued(job)) return 'Queued';
		return channel.state || 'Active';
	}

	function statusTone(channel: BoardChannel, job: HermesJob | null): Tone {
		if (!channel.active) return 'archived';
		const activeRun = currentRunForJob(channel, job);
		if (activeRun) return runStatusTone(activeRun);
		if (!job) return 'warn';
		if (!job?.enabled || channel.state === 'paused') return 'warn';
		if (channel.recentRun?.status) return runStatusTone(channel.recentRun);
		if (isErrorStatus(job?.lastStatus)) return 'error';
		if (isQueued(job)) return 'warn';
		return 'ok';
	}

	function isErrorStatus(status: string | null | undefined): boolean {
		return ['failed', 'error', 'errored', 'cancelled', 'canceled'].includes(String(status ?? '').toLowerCase());
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

	function runWatchTone(status: RunWatchStatus): Tone {
		if (status === 'failed') return 'error';
		if (status === 'timeout' || status === 'finished-no-output') return 'warn';
		if (status === 'output-saved') return 'ok';
		if (status === 'queued') return 'warn';
		return 'running';
	}
</script>

<svelte:head>
	<title>{focusedChannelView && selectedChannel ? `${selectedChannel.name} · NewsCraft` : 'Missions · NewsCraft'}</title>
</svelte:head>

<div class="page">
	<div class="channels">
			<header class="channels__masthead">
				<div>
						<div class="channels__eyebrow">
							{focusedChannelView && selectedChannel ? 'Recurring mission' : 'Mission control'}
						</div>
						{#if focusedChannelView && selectedChannel}
							{#if renameOpen}
								<form class="channels__rename" onsubmit={onRenameSubmit}>
									<input
										class="field__input channels__rename-input"
										bind:value={renameDraft}
										placeholder="Mission name"
										disabled={renameBusy}
									/>
									<div class="channels__rename-actions">
										<button type="submit" class="btn btn--primary" disabled={renameBusy}>
											{renameBusy ? 'Saving' : 'Save'}
										</button>
										<button
											type="button"
											class="btn btn--ghost"
											onclick={cancelRenameTitle}
											disabled={renameBusy}
										>
											Cancel
										</button>
									</div>
								</form>
							{:else}
								<h1 class="channels__title">{selectedChannel.name}</h1>
							{/if}
							{#if selectedJob?.description}
								<p class="channels__intro">{selectedJob.description}</p>
							{/if}
						{:else}
							<h1 class="channels__title">Missions</h1>
						{/if}
						{#if !selectedJob?.description}
						<p class="channels__intro">
						{#if focusedChannelView && selectedChannel}
							Run progress, schedule, and controls for this mission.
						{:else}
							Recurring newsroom intelligence tasks live here.
						{/if}
					</p>
						{/if}
				</div>
				<div class="channels__masthead-actions">
					<button type="button" class="btn btn--primary" onclick={openCreate}>
						<Plus size="14" strokeWidth={1.8} />
						New mission
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
		{#if visibleNotice}
			<div class="channels__notice">{visibleNotice}</div>
		{/if}
			{#if jobsError}
				<div class="channels__notice">
					Saved mission data loaded. Live mission controls are unavailable: {jobsError}
				</div>
			{/if}

			{#if createOpen}
					<form class="channels-create" onsubmit={onCreateSubmit}>
						<div class="channels-create__head">
							<div>
								<div class="channels__eyebrow">
									{formMode === 'edit' ? 'Edit recurring mission' : 'New recurring mission'}
								</div>
								<h2 class="channels-create__title">{formMode === 'edit' ? 'Edit mission' : 'Create mission'}</h2>
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
							<label class="field__label" for="mission-description">Description</label>
							<input
								id="mission-description"
								class="field__input"
								bind:value={createDescription}
								placeholder="Recurring brief for newsroom intelligence"
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
					<div class="channels-watchlist">
						<div class="channels-watchlist__head">
							<div>
								<div class="field__label">Attached sources</div>
							</div>
							<button type="button" class="btn btn--ghost" onclick={addSource} disabled={createBusy}>
								<Plus size="14" strokeWidth={1.8} />
								Add source
							</button>
						</div>
						{#if createSources.length > 0}
							<div class="channels-watchlist__rows">
								{#each createSources as source, index (source.id)}
									<div class="channels-watchlist__row">
										<div class="field">
											<label class="field__label" for={`channel-source-name-${index}`}>Name</label>
											<input
												id={`channel-source-name-${index}`}
												class="field__input"
												value={source.name}
												placeholder="FDA newsroom"
												disabled={createBusy}
												oninput={(event) =>
													updateSource(index, 'name', (event.currentTarget as HTMLInputElement).value)}
											/>
										</div>
										<div class="field">
											<label class="field__label" for={`channel-source-url-${index}`}>URL</label>
											<input
												id={`channel-source-url-${index}`}
												class="field__input"
												value={source.url}
												placeholder="https://example.com/news"
												disabled={createBusy}
												oninput={(event) =>
													updateSource(index, 'url', (event.currentTarget as HTMLInputElement).value)}
											/>
										</div>
										<button
											type="button"
											class="btn btn--ghost channels-watchlist__remove"
											aria-label="Remove source"
											title="Remove source"
											disabled={createBusy}
											onclick={() => removeSource(index)}
										>
											<Trash2 size="14" strokeWidth={1.8} />
										</button>
									</div>
								{/each}
							</div>
						{:else}
							<div class="channels-watchlist__empty">No attached sources configured.</div>
						{/if}
					</div>
					<div class="field">
						<label class="field__label" for="channel-deliver">Delivery target</label>
						<input
							id="channel-deliver"
							class="field__input"
							bind:value={createDeliver}
							placeholder="database (recommended)"
						/>
					</div>
					<div class="field">
						<label class="field__label" for="mission-output-format">Output format</label>
						<input
							id="mission-output-format"
							class="field__input"
							bind:value={createOutputFormat}
							placeholder="markdown"
						/>
					</div>
					<div class="channels-create__actions">
						<button type="submit" class="btn btn--primary" disabled={createBusy}>
							{#if formMode === 'edit'}
								<Pencil size="14" strokeWidth={1.8} />
								{createBusy ? 'Saving' : 'Save changes'}
							{:else}
								<Plus size="14" strokeWidth={1.8} />
								{createBusy ? 'Creating' : 'Create mission'}
							{/if}
						</button>
					</div>
				</form>
			{/if}

			<div class="channels__layout" class:channels__layout--focused={focusedChannelView}>
			{#if !focusedChannelView}
				<aside class="channels__rail" aria-label="Missions">
					<div class="channels__rail-title">Missions</div>
					{#if busy && channels.length === 0}
						<div class="channels__empty">Loading missions…</div>
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
										{relativeDate(channel.latestRunAt)}
									</span>
								</span>
								<span class={`channels-status channels-status--${statusTone(channel, job)}`}>
									{statusLabel(channel, job)}
								</span>
							</button>
						{:else}
							<div class="channels__empty">No missions yet.</div>
						{/each}
					{/if}
				</aside>
			{/if}

			<section class="channels__main" aria-live="polite">
				{#if selectedChannel}
					<header class="channel-head">
						<div class="channel-head__meta" aria-label="Mission status">
							<span class={`channels-status channels-status--${statusTone(selectedChannel, selectedJob)}`}>
								{statusLabel(selectedChannel, selectedJob)}
							</span>
							<span>
								{selectedRun
									? `Running since ${relativeDate(runStartedAt(selectedRun))}`
									: `Last update ${relativeDate(
											missionActivityAt(selectedChannel, selectedJob, selectedProgressRun)
										)}`}
							</span>
							{#if !selectedChannel.active}
								<span>Archived output</span>
							{/if}
						</div>

							<div class="channel-head__actions" aria-label="Mission controls">
								{#if selectedJob}
									<button
										type="button"
										class="btn btn--ghost"
										disabled={Boolean(actionBusy)}
										onclick={openEdit}
									>
										<Pencil size="13" strokeWidth={1.8} />
										Edit mission
									</button>
									<button
										type="button"
										class="btn btn--ghost"
										disabled={Boolean(actionBusy) || selectedJobRunning}
										onclick={() => jobAction('run')}
									>
										<Play size="13" strokeWidth={1.8} />
										{selectedJobRunning ? 'Running' : actionBusy === 'run' ? 'Starting' : 'Run now'}
									</button>
									{#if selectedJob.enabled}
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
									<button
										type="button"
										class="btn btn--ghost channels__btn-danger"
										disabled={Boolean(actionBusy)}
										onclick={deleteSelectedMission}
									>
										<Trash2 size="13" strokeWidth={1.8} />
										{actionBusy === 'delete' ? 'Deleting' : 'Delete'}
									</button>
								{/if}
							</div>
						</header>
					{#if runWatchVisible && runWatch}
						<div class="run-watch" aria-live="polite">
							<div class="run-watch__left">
								<span class={`channels-status channels-status--${runWatchTone(runWatch.status)}`}>
									{runWatch.status === 'requested'
										? 'Requested'
										: runWatch.status === 'queued'
											? 'Queued'
											: runWatch.status === 'running'
												? 'Running'
												: runWatch.status === 'finishing'
													? 'Finishing'
												: runWatch.status === 'output-saved'
													? 'Completed'
													: runWatch.status === 'failed'
														? 'Failed'
														: runWatch.status === 'finished-no-output'
															? 'Done'
															: 'Timed out'}
								</span>
								<span class="run-watch__message">{runWatch.message}</span>
								{#if runWatchElapsed || runWatch.lastCheckedAt || runWatch.detail}
									<details class="run-watch__details">
										<summary>Details</summary>
										<div class="run-watch__details-body">
											{#if runWatchElapsed}
												<span class="run-watch__meta">Waiting {runWatchElapsed}</span>
											{/if}
											{#if runWatch.lastCheckedAt}
												<span class="run-watch__meta">
													Last checked {formatRelativeTime(runWatch.lastCheckedAt)}
												</span>
											{/if}
											{#if runWatch.detail}
												<span class="run-watch__detail">{runWatch.detail}</span>
											{/if}
										</div>
									</details>
								{/if}
							</div>
							<div class="run-watch__actions">
								<button type="button" class="btn btn--ghost" onclick={dismissRunWatch}>
									Dismiss
								</button>
							</div>
						</div>
					{/if}

					<details class="channel-detail" aria-label="Mission details">
						<summary>Mission details</summary>
						<div class="channel-detail__grid">
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
							<div class="channel-detail__item">
								<span>Output</span>
								<strong>{selectedJob?.outputFormat ?? 'markdown'}</strong>
							</div>
							<div class="channel-detail__item">
								<span>Sources</span>
								<strong>
									{selectedSources.length}
									{selectedSources.length === 1 ? 'source' : 'sources'}
								</strong>
							</div>
							<div class="channel-detail__item">
								<span>Mission id</span>
								<strong>{selectedJob?.id ?? selectedChannel.jobId ?? selectedChannel.slug}</strong>
							</div>
						</div>
					</details>
					{#if selectedSources.length > 0}
						<div class="channel-sources" aria-label="Mission sources">
							<div class="channel-sources__title">Attached sources</div>
							<div class="channel-sources__list">
								{#each selectedSources as source (source.id)}
									<a class="channel-source" href={source.url} target="_blank" rel="noreferrer">
										<span class="channel-source__name">{source.name}</span>
										<span class="channel-source__url">{sourceHost(source.url)}</span>
									</a>
								{/each}
							</div>
						</div>
					{/if}

					<section class="mission-progress" aria-label="Mission progress">
						<div class="mission-progress__head">
							<div>
								<div class="channels__eyebrow">Run progress</div>
								<h2 class="mission-progress__title">
									{selectedProgressRun ? 'Latest run activity' : 'No runs yet'}
								</h2>
							</div>
							{#if selectedProgressRun}
								<span class={`channels-status channels-status--${runStatusTone(selectedProgressRun)}`}>
									{runStatusLabel(selectedProgressRun)}
								</span>
							{/if}
						</div>
						{#if selectedProgressRun}
							<div class="mission-progress__stats">
								<div>
									<span>Started</span>
									<strong>{formatDate(runStartedAt(selectedProgressRun))}</strong>
								</div>
								<div>
									<span>Updated</span>
									<strong>{relativeDate(latestRunActivity(selectedProgressRun))}</strong>
								</div>
								<div>
									<span>Elapsed</span>
									<strong>{formatElapsed(selectedProgressRun.elapsedMs) ?? '—'}</strong>
								</div>
								<div>
									<span>Sources</span>
									<strong>{selectedProgressRun.sourceCount ?? 0}</strong>
								</div>
							</div>
							{#if selectedProgressRun.lastError}
								<div class="mission-progress__error">{selectedProgressRun.lastError}</div>
							{/if}
							{#if selectedProgressItems.length > 0}
								<div class="mission-progress__timeline">
									{#each selectedProgressItems as item (item.id)}
										<div class="mission-progress__item">
											<span class={`mission-progress__dot mission-progress__dot--${item.tone}`}></span>
											<div>
												<strong>{item.label}</strong>
												<span>
													{progressStatusLabel(item.status)}
													{#if item.time}
														· {relativeDate(item.time)}
													{/if}
												</span>
												{#if item.detail}
													<span class="mission-progress__detail">{item.detail}</span>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{:else}
								<div class="channels__empty channels__empty--panel">
									{runStatusLabel(selectedProgressRun)}. Progress details will appear as the runner records steps and tools.
								</div>
							{/if}
						{:else}
							<div class="channels__empty channels__empty--panel">
								Run this mission to see queued, running, source, and completion progress here.
							</div>
						{/if}
					</section>

					{#if latestPost}
						<section class="latest-output" aria-label="Latest saved output">
							<div class="latest-output__head">
								<span>Latest saved output</span>
								<strong>{formatDate(latestPost.runTime)}</strong>
							</div>
							<p>{latestPost.preview || 'Output saved for this mission.'}</p>
							<details
								class="latest-output__details"
								open={latestOutputExpanded}
								ontoggle={(event) => handleLatestOutputToggle(event, latestPost)}
							>
								<summary>View full output</summary>
								{#if outputLoadingId === latestPost.id}
									<div class="latest-output__status">Loading saved output...</div>
								{:else if outputLoadError}
									<div class="latest-output__status latest-output__status--error">
										Could not load saved output: {outputLoadError}
									</div>
								{:else if latestOutputMarkdown}
									<pre>{latestOutputMarkdown}</pre>
								{:else}
									<div class="latest-output__status">No full output was saved for this report.</div>
								{/if}
							</details>
						</section>
					{/if}
				{:else}
					<div class="channels__empty channels__empty--panel">No missions yet.</div>
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
		.channels__rename {
			display: grid;
			gap: 8px;
			margin-top: 4px;
			max-width: 560px;
		}
		.channels__rename-input {
			height: 38px;
		}
		.channels__rename-actions {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
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
		.channels__btn-danger {
			color: var(--status-breaking-fg);
			border-color: color-mix(in srgb, var(--status-breaking) 24%, var(--border-soft));
			background: color-mix(in srgb, var(--status-breaking-bg) 38%, var(--bg-surface));
		}
		.channels__btn-danger:hover:not(:disabled) {
			border-color: color-mix(in srgb, var(--status-breaking) 38%, var(--border-soft));
			background: color-mix(in srgb, var(--status-breaking-bg) 58%, var(--bg-surface));
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
		.channels-watchlist {
			display: grid;
			gap: 10px;
			margin: 12px 0;
		}
		.channels-watchlist__head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
		}
		.channels-watchlist__rows {
			display: grid;
			gap: 8px;
		}
		.channels-watchlist__row {
			display: grid;
			grid-template-columns: minmax(140px, 0.85fr) minmax(220px, 1.35fr) auto;
			gap: 8px;
			align-items: end;
			border: 1px solid var(--border-soft);
			border-radius: var(--radius-2);
			background: color-mix(in srgb, var(--bg-surface) 78%, var(--bg-page));
			padding: 10px;
		}
		.channels-watchlist__remove {
			width: 34px;
			height: 34px;
			padding: 0;
			justify-content: center;
		}
		.channels-watchlist__empty {
			border: 1px dashed var(--border-soft);
			border-radius: var(--radius-2);
			padding: 12px;
			font-size: 13px;
			color: var(--fg-3);
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
	.channel-feed-row:focus-visible {
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
	.channel-head__meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 7px;
		color: var(--fg-3);
	}
	.channel-head__meta span:not(.channels-status) {
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
	.run-watch {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
		border-radius: var(--radius-2);
		padding: 10px 12px;
		margin: -4px 0 14px;
	}
	.run-watch__left {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.run-watch__message {
		font-size: 13px;
		color: var(--fg-2);
	}
	.run-watch__meta {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}
	.run-watch__details {
		flex-basis: 100%;
		margin-top: 2px;
	}
	.run-watch__details summary {
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}
	.run-watch__details summary::marker {
		font-size: 10px;
	}
	.run-watch__details-body {
		margin-top: 6px;
		display: grid;
		gap: 4px;
	}
	.run-watch__detail {
		font-size: 12px;
		color: var(--fg-3);
	}
	.run-watch__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}
	.channel-detail {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		margin-bottom: 18px;
		padding: 10px 12px;
	}
	.channel-detail summary {
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}
	.channel-detail summary::marker {
		font-size: 10px;
	}
	.channel-detail__grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 1px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--border-soft);
		overflow: hidden;
		margin-top: 10px;
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
	.channel-sources {
		display: grid;
		gap: 8px;
		margin: -6px 0 18px;
	}
	.channel-sources__title {
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}
	.channel-sources__list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.channel-source {
		min-width: 0;
		max-width: min(100%, 320px);
		display: inline-grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 2px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		padding: 8px 10px;
		text-decoration: none;
		color: var(--fg-1);
	}
	.channel-source:hover {
		border-color: var(--border-strong);
	}
	.channel-source__name,
	.channel-source__url {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.channel-source__name {
		font-size: 13px;
		font-weight: 650;
	}
	.channel-source__url {
		font-size: 12px;
		color: var(--fg-3);
	}
	.mission-progress,
	.latest-output {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		padding: 14px;
		margin-bottom: 14px;
	}
	.mission-progress__head,
	.latest-output__head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.mission-progress__title {
		margin: 3px 0 0;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.15;
		letter-spacing: 0;
		color: var(--fg-1);
	}
	.mission-progress__stats {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--border-soft);
		overflow: hidden;
		margin-bottom: 12px;
	}
	.mission-progress__stats div {
		min-width: 0;
		display: grid;
		gap: 4px;
		background: var(--bg-surface);
		padding: 10px;
	}
	.mission-progress__stats span,
	.latest-output__head span {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--fg-3);
	}
	.mission-progress__stats strong,
	.latest-output__head strong {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		color: var(--fg-1);
	}
	.mission-progress__error {
		margin-bottom: 12px;
		border: 1px solid color-mix(in srgb, var(--status-breaking) 24%, var(--border-soft));
		border-radius: var(--radius-2);
		background: var(--status-breaking-bg);
		color: var(--status-breaking-fg);
		padding: 10px 12px;
		font-size: 13px;
		line-height: 1.4;
	}
	.mission-progress__timeline {
		display: grid;
		gap: 9px;
	}
	.mission-progress__item {
		display: grid;
		grid-template-columns: 9px minmax(0, 1fr);
		gap: 10px;
		align-items: start;
	}
	.mission-progress__item strong,
	.mission-progress__item span {
		display: block;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.mission-progress__item strong {
		font-size: 13px;
		color: var(--fg-1);
	}
	.mission-progress__item span {
		font-size: 12px;
		color: var(--fg-3);
		line-height: 1.35;
	}
	.mission-progress__detail {
		margin-top: 2px;
		color: var(--status-breaking-fg) !important;
	}
	.mission-progress__dot {
		width: 8px;
		height: 8px;
		margin-top: 5px;
		border-radius: 999px;
		background: var(--fg-4);
	}
	.mission-progress__dot--ok {
		background: var(--status-verified);
	}
	.mission-progress__dot--warn {
		background: var(--status-review);
	}
	.mission-progress__dot--error {
		background: var(--status-breaking);
	}
	.mission-progress__dot--running {
		background: var(--accent);
	}
	.latest-output {
		background: color-mix(in srgb, var(--bg-surface) 78%, var(--bg-page));
	}
	.latest-output__head {
		align-items: center;
		margin-bottom: 6px;
	}
	.latest-output p {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		color: var(--fg-2);
		display: -webkit-box;
		line-clamp: 3;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.latest-output__details {
		margin-top: 10px;
		border-top: 1px solid var(--border-soft);
		padding-top: 10px;
	}
	.latest-output__details summary {
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--fg-3);
	}
	.latest-output__details summary:hover {
		color: var(--fg-1);
	}
	.latest-output__details pre {
		margin: 10px 0 0;
		max-height: min(58vh, 680px);
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		padding: 12px;
		font-family: var(--font-body);
		font-size: 13px;
		line-height: 1.5;
		color: var(--fg-1);
	}
	.latest-output__status {
		margin-top: 10px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		padding: 10px 12px;
		font-size: 13px;
		color: var(--fg-3);
	}
	.latest-output__status--error {
		border-color: color-mix(in srgb, var(--status-breaking) 36%, var(--border-soft));
		color: var(--status-breaking);
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
			.channel-detail__grid {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
			.channels-create__grid {
				grid-template-columns: 1fr;
			}
			.channels-watchlist__row {
				grid-template-columns: 1fr;
			}
			.channels-watchlist__remove {
				width: 100%;
			}
			.mission-progress__stats {
				grid-template-columns: repeat(2, minmax(0, 1fr));
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
		.run-watch,
		.run-watch__actions,
		.channels__masthead-actions,
		.channel-head__actions :global(.btn) {
			width: 100%;
		}
			.channel-detail__grid {
				grid-template-columns: 1fr;
			}
			.mission-progress__stats {
				grid-template-columns: 1fr;
			}
			.channels__title {
				font-size: 30px;
			}
	}
</style>
