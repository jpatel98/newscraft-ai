<script lang="ts">
	import { replaceState } from '$app/navigation';
	import Composer from '$lib/components/Composer.svelte';
	import OpenGateCard from '$lib/components/OpenGateCard.svelte';
	import { segmentDraftWithCitations, type CitationRecord } from '$lib/utils/citations';
	import type {
		AgentJob,
		AgentRun,
		BoardData,
		BoardPost,
		ChannelSource,
		EditorialEvent,
		EditorialGate,
		MessageContent
	} from '$lib/types';
	import { contentText } from '$lib/types';
	import {
		createGateEvent,
		createStoryWorkspace,
		type PitchGateResolution,
		type StoryWorkspace,
		type WorkspaceEvent,
		type WorkspacePitch
	} from '$lib/utils/story-workspace';
	import { onMount } from 'svelte';

	let {
		data
	}: {
		data: {
			board: BoardData | null;
			boardError: string | null;
			gates: EditorialGate[];
			gateEvents: EditorialEvent[];
			gateError: string | null;
			missionsEnabled: boolean;
		};
	} = $props();

	let composer: Composer | undefined = $state();
	let gateResolutions = $state<Record<string, PitchGateResolution>>({});
	let gateEvents = $state<WorkspaceEvent[]>([]);
	let gateOverrides = $state<Record<string, EditorialGate>>({});
	let eventOverrides = $state<Record<string, EditorialEvent>>({});
	let gateActionBusy = $state<string | null>(null);
	let gateResolveError = $state<string | null>(null);
	let workspaces = $state<StoryWorkspace[]>([]);
	let selectedWorkspaceId = $state<string | null>(null);
	let selectedCitationMarker = $state<number | null>(null);
	let commandBusy = $state(false);
	let commandError = $state<string | null>(null);
	let commandResult = $state<CommandBarResult | null>(null);

	const starters = [
		{
			label: 'Find story leads',
			prompt: 'Review my beats and show me the strongest story leads for today.'
		},
		{
			label: 'Read this source',
			prompt: 'Read this source and flag anything worth following up: '
		},
		{
			label: 'Draft a story',
			prompt: 'Draft a 300-word web story from this lead using only sourced facts.'
		}
	];

	const board = $derived(data.board);
	const jobsById = $derived(new Map((board?.jobs ?? []).map((job) => [job.id, job])));
	const pitches = $derived(
		(board?.posts ?? [])
			.filter((post) => !post.archived)
			.sort((a, b) => timestampMs(b.runTime) - timestampMs(a.runTime))
			.slice(0, 6)
			.map((post) => pitchFromPost(post, jobsById.get(post.jobId)))
	);
	const visiblePitches = $derived(pitches.filter((pitch) => gateResolutions[pitch.id] !== 'spiked'));
	const editorialGates = $derived(data.gates.map((gate) => gateOverrides[gate.id] ?? gate));
	const persistedEvents = $derived([
		...Object.values(eventOverrides),
		...data.gateEvents.filter((event) => !eventOverrides[event.id])
	]);
	const openGates = $derived(editorialGates.filter((gate) => gate.status === 'open'));
	const standingBriefs = $derived((board?.jobs ?? []).filter((job) => job.enabled).slice(0, 4));
	const pausedBriefs = $derived((board?.jobs ?? []).filter((job) => !job.enabled).length);
	const selectedWorkspace = $derived(
		(selectedWorkspaceId ? workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : workspaces[0]) ?? null
	);
	const selectedWorkspacePitch = $derived(
		selectedWorkspace ? (pitches.find((pitch) => pitch.id === selectedWorkspace.pitchId) ?? null) : null
	);
	const selectedWorkspaceRuns = $derived(
		selectedWorkspace ? runsForWorkspace(selectedWorkspace, selectedWorkspacePitch) : []
	);
	const selectedWorkspaceWire = $derived(workspaceWire(selectedWorkspace, selectedWorkspaceRuns));
	const selectedDraftSegments = $derived(
		selectedWorkspace ? segmentDraftWithCitations(selectedWorkspace.draft, selectedWorkspace.citations) : []
	);
	const selectedCitation = $derived(citationForMarker(selectedWorkspace?.citations ?? [], selectedCitationMarker));
	const wireItems = $derived(
		[...persistedEvents.map(wireFromEditorialEvent), ...gateEvents.map(wireFromWorkspaceEvent), ...wireFromBoard(board)]
			.sort((a, b) => timestampMs(b.at) - timestampMs(a.at))
			.slice(0, 10)
	);

	onMount(() => {
		const draft = new URL(location.href).searchParams.get('draft');
		if (!draft) return;
		composer?.setValue(draft);
		replaceState('/', {});
	});

	interface Pitch extends WorkspacePitch {
		id: string;
		jobId: string;
		beat: string;
		title: string;
		angle: string;
		whyNow: string;
		confidence: number;
		confidenceLabel: string;
		sources: ChannelSource[];
		runTime: string | null;
		report: string;
	}

	interface WireItem {
		id: string;
		kind: string;
		label: string;
		detail: string;
		at: string | null;
		tone: 'neutral' | 'active' | 'warning';
	}

	interface CommandBarResult {
		ok: boolean;
		status: 'completed' | 'blocked';
		handled_by: 'Monitor' | 'Research' | 'Drafting';
		agent: 'beat_monitor' | 'research' | 'drafting';
		route_reason: string;
		command_excerpt: string;
		source?: {
			url: string;
			title: string;
			summary: string;
			adapter: string | null;
			content_hash: string;
			archive_snapshot_url: string | null;
		};
		claim?: {
			id: string;
			claim: string;
			status: 'proposed';
		};
		target_claim?: {
			id: string | null;
			index: number | null;
			claim: string;
			status: string | null;
			source_urls: string[];
		} | null;
		draft?: {
			headline?: string;
			word_count?: number;
		};
		error?: string;
	}

	async function handleCommandSend(content: MessageContent) {
		const command = contentText(content);
		if (!command || commandBusy) return;
		commandBusy = true;
		commandError = null;
		commandResult = null;
		try {
			const response = await fetch('/api/agent/editor-command', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					command,
					workspaceId: selectedWorkspace?.id,
					storyId: selectedWorkspace?.id,
					jobId: selectedWorkspacePitch?.jobId,
					targetAgent: commandTarget(command),
					facts: commandFacts(selectedWorkspace)
				})
			});
			const body = (await response.json().catch(() => null)) as { result?: CommandBarResult; message?: string } | null;
			if (!response.ok || !body?.result) {
				throw new Error(body?.message || `Command failed with ${response.status}`);
			}
			commandResult = body.result;
			gateEvents = [wireEventFromCommandResult(body.result), ...gateEvents];
		} catch (err) {
			commandError = err instanceof Error ? err.message : String(err);
		} finally {
			commandBusy = false;
		}
	}

	function commandTarget(command: string): 'monitor' | 'research' | 'drafting' | null {
		if (selectedWorkspace && /https?:\/\//i.test(command)) return 'research';
		if (selectedWorkspace && /\b(draft|write|lede|headline)\b/i.test(command)) return 'drafting';
		if (
			selectedWorkspace &&
			/\b(counter[- ]?source|counter source|research|claim|fact|corroborat|contradict|verify source)\b/i.test(command)
		) {
			return 'research';
		}
		if (/https?:\/\//i.test(command) || /\bread this\b/i.test(command)) return 'monitor';
		if (/\b(lead|leads|source|monitor|beat)\b/i.test(command)) return 'monitor';
		return null;
	}

	function commandFacts(workspace: StoryWorkspace | null): unknown[] | undefined {
		if (!workspace) return undefined;
		const sources = workspace.citations.map((citation) => ({
			title: citation.sourceTitle,
			name: citation.sourceName,
			url: citation.sourceUrl,
			archive_snapshot_url: citation.archiveUrl,
			content_hash: citation.contentHash
		}));
		if (sources.length === 0) return undefined;
		return [
			{
				id: `${workspace.id}-title`,
				claim: workspace.title,
				status: 'verified',
				sources
			},
			{
				id: `${workspace.id}-angle`,
				claim: workspace.angle,
				status: 'verified',
				sources
			},
			{
				id: `${workspace.id}-why-now`,
				claim: workspace.whyNow,
				status: 'verified',
				sources
			},
			...workspace.factLedger
				.filter((fact) => fact.sourceUrl)
				.map((fact) => ({
					id: fact.id,
					claim: fact.detail,
					status: 'verified',
					sources: [
						{
							title: fact.sourceName || fact.detail,
							name: fact.sourceName || fact.detail,
							url: fact.sourceUrl,
							archive_snapshot_url: fact.archiveUrl,
							content_hash: fact.contentHash ?? null
						}
					]
				}))
		];
	}

	function wireEventFromCommandResult(result: CommandBarResult): WorkspaceEvent {
		return {
			id: `command-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			kind: result.agent,
			label: `${result.handled_by} handled command`,
			detail: commandResultDetail(result),
			at: new Date().toISOString(),
			tone: result.status === 'blocked' ? 'warning' : 'active'
		};
	}

	function commandResultDetail(result: CommandBarResult): string {
		if (result.error) return result.error;
		if (result.claim) return `Proposed fact-ledger claim: ${trimText(result.claim.claim, 120)}`;
		if (result.source) return `Extracted ${result.source.title} through ${result.source.adapter || 'source adapter'}.`;
		if (result.draft) return `Drafted ${result.draft.headline || 'web story'} for review.`;
		if (result.target_claim) return `Queued research on claim ${result.target_claim.index ?? ''}.`;
		return result.route_reason;
	}

	function pitchFromPost(post: BoardPost, job: AgentJob | undefined): Pitch {
		const sources = (job?.sources ?? []).filter((source) => source.enabled !== false);
		const report = post.responseMarkdown || post.preview || '';
		const angle = extractAngle(report, post.preview);
		const confidence = confidenceFor(post, job, sources);
		return {
			id: post.id,
			jobId: post.jobId,
			beat: post.channel || job?.name || 'Newsroom beat',
			title: extractTitle(report, post.preview, post.channel || job?.name || 'Newsroom pitch'),
			angle,
			whyNow: whyNow(post, job),
			confidence,
			confidenceLabel: confidence >= 82 ? 'High' : confidence >= 68 ? 'Medium' : 'Needs review',
			sources,
			runTime: post.runTime,
			report
		};
	}

	function confidenceFor(post: BoardPost, job: AgentJob | undefined, sources: ChannelSource[]): number {
		let score = 58;
		if (post.preview || post.responseMarkdown) score += 10;
		if (post.runTime && Date.now() - timestampMs(post.runTime) < 36 * 60 * 60 * 1000) score += 10;
		score += Math.min(18, sources.length * 6);
		if (job?.lastStatus === 'failed' || post.runStatus === 'failed') score -= 12;
		return Math.max(40, Math.min(96, score));
	}

	function extractTitle(report: string, preview: string, fallback: string): string {
		const candidate = firstUsefulLine(`${preview}\n${report}`);
		return trimText(candidate || `${fallback} pitch`, 96);
	}

	function extractAngle(report: string, preview: string): string {
		const paragraphs = `${preview}\n${report}`
			.split(/\n{2,}|\n/)
			.map((line) => cleanLine(line))
			.filter((line) => line.length > 32 && !/^(mission|schedule|run time|source notes|verification notes)\b/i.test(line));
		return trimText(paragraphs[0] || 'Monitor surfaced this as a candidate angle for editor review.', 190);
	}

	function firstUsefulLine(value: string): string {
		return (
			value
				.split(/\n+/)
				.map((line) => cleanLine(line))
				.find((line) => line.length > 8 && !/^(mission report|latest saved output|source notes|verification notes)\b/i.test(line)) || ''
		);
	}

	function cleanLine(value: string): string {
		return value
			.replace(/^#{1,6}\s*/, '')
			.replace(/^[-*]\s*/, '')
			.replace(/^\d+\.\s*/, '')
			.replace(/\*\*/g, '')
			.trim();
	}

	function trimText(value: string, max: number): string {
		if (value.length <= max) return value;
		return `${value.slice(0, max - 1).trim()}...`;
	}

	function whyNow(post: BoardPost, job: AgentJob | undefined): string {
		const lastRun = post.runTime || job?.lastRunAt;
		if (lastRun) return `Latest monitor pass ${relativeTime(lastRun)} surfaced a gate for editor review.`;
		if (job?.nextRunAt) return `Standing Brief is scheduled; next monitor pass is ${relativeTime(job.nextRunAt)}.`;
		return 'Standing Brief has enough configured context to ask the monitor for a pitch check.';
	}

	function timestampMs(value: string | null | undefined): number {
		if (!value) return 0;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}

	function relativeTime(value: string | null | undefined): string {
		const timestamp = timestampMs(value);
		if (!timestamp) return 'recently';
		const delta = timestamp - Date.now();
		const abs = Math.abs(delta);
		const minutes = Math.round(abs / 60_000);
		const hours = Math.round(abs / 3_600_000);
		const days = Math.round(abs / 86_400_000);
		const suffix = delta >= 0 ? 'from now' : 'ago';
		if (minutes < 60) return `${Math.max(1, minutes)}m ${suffix}`;
		if (hours < 36) return `${hours}h ${suffix}`;
		return `${days}d ${suffix}`;
	}

	function sourceHost(url: string): string {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return url;
		}
	}

	function resolveGate(pitch: Pitch, resolution: PitchGateResolution) {
		const now = new Date().toISOString();
		gateResolutions = { ...gateResolutions, [pitch.id]: resolution };
		gateEvents = [createGateEvent(pitch, resolution, now), ...gateEvents].slice(0, 12);
		if (resolution !== 'accepted') return;

		const existing = workspaces.find((workspace) => workspace.pitchId === pitch.id);
		if (existing) {
			selectedWorkspaceId = existing.id;
			selectedCitationMarker = existing.citations[0]?.marker ?? null;
			return;
		}

		const workspace = createStoryWorkspace(pitch, now);
		workspaces = [workspace, ...workspaces];
		selectedWorkspaceId = workspace.id;
		selectedCitationMarker = workspace.citations[0]?.marker ?? null;
	}

	async function resolveEditorialGateCard(gate: EditorialGate, action: string, notes: string) {
		gateActionBusy = gate.id;
		gateResolveError = null;
		try {
			const response = await fetch(`/api/gates/${encodeURIComponent(gate.id)}/resolve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, notes })
			});
			if (!response.ok) throw new Error(await response.text());
			const body = (await response.json()) as { gate?: EditorialGate; event?: EditorialEvent };
			if (body.gate) {
				gateOverrides = { ...gateOverrides, [body.gate.id]: body.gate };
			}
			if (body.event) {
				eventOverrides = { ...eventOverrides, [body.event.id]: body.event };
			}
		} catch (err) {
			gateResolveError = err instanceof Error ? err.message : String(err);
		} finally {
			gateActionBusy = null;
		}
	}

	function resolutionLabel(resolution: PitchGateResolution | undefined): string | null {
		if (resolution === 'accepted') return 'Accepted';
		if (resolution === 'held') return 'Held';
		if (resolution === 'spiked') return 'Spiked';
		return null;
	}

	function selectWorkspace(workspace: StoryWorkspace) {
		selectedWorkspaceId = workspace.id;
		selectedCitationMarker = workspace.citations[0]?.marker ?? null;
	}

	function citationForMarker(citations: CitationRecord[], marker: number | null): CitationRecord | null {
		if (marker !== null) {
			const match = citations.find((citation) => citation.marker === marker);
			if (match) return match;
		}
		return citations[0] ?? null;
	}

	function runsForWorkspace(workspace: StoryWorkspace, pitch: Pitch | null): AgentRun[] {
		const runs = board?.runs ?? [];
		return runs
			.filter((run) => {
				if (pitch?.jobId && run.jobId === pitch.jobId) return true;
				return (run.jobName || '').toLowerCase() === workspace.beat.toLowerCase();
			})
			.sort((a, b) => timestampMs(b.latestActivityAt ?? b.updatedAt ?? b.startedAt ?? b.queuedAt) - timestampMs(a.latestActivityAt ?? a.updatedAt ?? a.startedAt ?? a.queuedAt))
			.slice(0, 4);
	}

	function workspaceWire(workspace: StoryWorkspace | null, runs: AgentRun[]): WireItem[] {
		if (!workspace) return [];
		const events: WireItem[] = [...workspace.eventLog, ...workspace.activity].map((event) => ({
			id: event.id,
			kind: event.kind,
			label: event.label,
			detail: event.detail,
			at: event.at,
			tone: event.tone
		}));
		const runItems: WireItem[] = runs.map((run) => ({
			id: `workspace-run:${workspace.id}:${run.id}`,
			kind: run.status === 'running' ? 'agent.live' : run.status === 'failed' ? 'agent.blocked' : 'agent.run',
			label: run.jobName || workspace.beat,
			detail:
				run.status === 'failed'
					? run.lastError || 'Agent team needs attention before this workspace can advance.'
					: run.status === 'running'
						? 'Live agent team activity is feeding this story workspace.'
						: `${run.sourceCount ?? 0} sources checked for this story.`,
			at: run.latestActivityAt ?? run.completedAt ?? run.updatedAt ?? run.startedAt ?? run.queuedAt ?? null,
			tone: run.status === 'failed' ? 'warning' : run.status === 'running' ? 'active' : 'neutral'
		}));
		return [...events, ...runItems].sort((a, b) => timestampMs(b.at) - timestampMs(a.at));
	}

	function wireFromWorkspaceEvent(event: WorkspaceEvent): WireItem {
		return {
			id: `gate:${event.id}`,
			kind: event.kind,
			label: event.label,
			detail: event.detail,
			at: event.at,
			tone: event.tone
		};
	}

	function wireFromEditorialEvent(event: EditorialEvent): WireItem {
		const payload = objectValue(event.payload);
		const title = stringValue(payload?.title) || stringValue(payload?.gate_title) || event.agent;
		const action = stringValue(payload?.action);
		const detail =
			event.kind === 'gate.resolved'
				? `${title} resolved${action ? ` with ${actionLabel(action)}` : ''}.`
				: event.kind === 'gate.queued'
					? `${title} is waiting for an editor decision.`
					: `${event.agent} wrote ${event.kind}.`;
		return {
			id: `event:${event.id}`,
			kind: event.kind,
			label: title,
			detail,
			at: event.createdAt,
			tone: event.kind === 'gate.resolved' ? 'active' : 'neutral'
		};
	}

	function objectValue(value: unknown): Record<string, unknown> | null {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	}

	function stringValue(value: unknown): string | null {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		return null;
	}

	function actionLabel(action: string): string {
		return action
			.split('_')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function wireFromBoard(value: BoardData | null): WireItem[] {
		if (!value) return [];
		const runItems: WireItem[] = (value.runs ?? []).map((run) => ({
			id: `run:${run.id}`,
			kind: run.status === 'running' ? 'monitor.active' : run.status === 'failed' ? 'source.health' : 'monitor.pass',
			label: run.jobName || value.jobs.find((job) => job.id === run.jobId)?.name || 'Beat monitor',
			detail:
				run.status === 'failed'
					? run.lastError || 'Monitor run needs attention.'
					: run.status === 'running'
						? 'Monitor is reading sources and updating the wire.'
						: `${run.sourceCount ?? 0} sources checked.`,
			at: run.latestActivityAt ?? run.completedAt ?? run.startedAt ?? run.queuedAt ?? null,
			tone: run.status === 'failed' ? 'warning' : run.status === 'running' ? 'active' : 'neutral'
		}));
		const postItems: WireItem[] = value.posts.slice(0, 8).map((post) => ({
			id: `post:${post.id}`,
			kind: 'pitch.gate',
			label: post.channel,
			detail: trimText(firstUsefulLine(`${post.preview}\n${post.responseMarkdown}`) || 'Pitch gate ready for editor review.', 130),
			at: post.runTime,
			tone: 'neutral'
		}));
		return [...runItems, ...postItems]
			.sort((a, b) => timestampMs(b.at) - timestampMs(a.at))
			.slice(0, 10);
	}
</script>

<svelte:head>
	<title>Pitch Queue · NewsCraft</title>
</svelte:head>

<div class="newsroom">
	<section class="newsroom-hero" aria-labelledby="newsroom-title">
		<div>
			<div class="newsroom-hero__eyebrow">Today</div>
			<h1 id="newsroom-title">Newsroom overview</h1>
			<p>
				Check for new leads, review active runs, and start a sourced draft from anything worth following.
			</p>
		</div>
		<div class="newsroom-hero__meta" aria-label="Newsroom status">
			<div>
				<strong>{visiblePitches.length}</strong>
				<span>new leads</span>
			</div>
			<div>
				<strong>{standingBriefs.length}</strong>
				<span>beats watched</span>
			</div>
			<div>
				<strong>{workspaces.length}</strong>
				<span>workspaces</span>
			</div>
		</div>
	</section>

	<section class="command-panel" aria-label="Editor command bar">
		<div class="command-panel__copy">
			<div class="panel-eyebrow">Ask NewsCraft</div>
			<p>Ask for leads, paste a source, or turn an accepted lead into a short web draft.</p>
		</div>
		<div class="command-panel__prompts" aria-label="Starter commands">
			{#each starters as starter}
				<button type="button" onclick={() => composer?.setValue(starter.prompt)}>{starter.label}</button>
			{/each}
		</div>
		<Composer
			bind:this={composer}
			placeholder="Ask for leads, paste a source URL, or draft from a lead..."
			onSend={handleCommandSend}
			disabled={commandBusy}
		/>
		{#if commandBusy || commandResult || commandError}
			<div class="command-panel__status" class:command-panel__status--warning={commandResult?.status === 'blocked' || commandError}>
				{#if commandBusy}
					<span>Routing command</span>
					<strong>{selectedWorkspace ? 'Research, Drafting, or Monitor' : 'Monitor'}</strong>
				{:else if commandResult}
					<span>{commandResult.handled_by}</span>
					<strong>{commandResult.status === 'blocked' ? 'Needs editor context' : commandResultDetail(commandResult)}</strong>
					<small>{commandResult.route_reason}</small>
				{:else if commandError}
					<span>Command failed</span>
					<strong>{commandError}</strong>
				{/if}
			</div>
		{/if}
	</section>

	{#if !data.missionsEnabled}
		<section class="newsroom-alert">
			<strong>Pitch Queue is waiting for Standing Briefs.</strong>
			<span>Enable missions to let beat monitors run against configured sources.</span>
		</section>
	{:else if data.boardError || board?.jobsError}
		<section class="newsroom-alert newsroom-alert--warning">
			<strong>Monitor backend needs attention.</strong>
			<span>{data.boardError || board?.jobsError}</span>
		</section>
	{/if}

	{#if data.gateError}
		<section class="newsroom-alert newsroom-alert--warning">
			<strong>Gate queue needs attention.</strong>
			<span>{data.gateError}</span>
		</section>
	{/if}

	{#if gateResolveError}
		<section class="newsroom-alert newsroom-alert--warning">
			<strong>Gate resolution failed.</strong>
			<span>{gateResolveError}</span>
		</section>
	{/if}

	{#if openGates.length}
		<section class="open-gates" aria-labelledby="open-gates-title">
			<div class="section-head">
				<div>
					<div class="panel-eyebrow">Decision Queue</div>
					<h2 id="open-gates-title">Open gates</h2>
				</div>
			</div>
			<div class="open-gates__list">
				{#each openGates as gate (gate.id)}
					<OpenGateCard
						{gate}
						busy={gateActionBusy === gate.id}
						onResolve={resolveEditorialGateCard}
					/>
				{/each}
			</div>
		</section>
	{/if}

	<div class="newsroom-grid">
		<section class="pitch-queue" aria-labelledby="pitch-queue-title">
			<div class="section-head">
				<div>
					<div class="panel-eyebrow">Story leads</div>
					<h2 id="pitch-queue-title">What looks worth chasing</h2>
				</div>
				<a href="/missions?new=1">Manage beats</a>
			</div>

			{#if visiblePitches.length}
				<div class="pitch-list">
					{#each visiblePitches as pitch (pitch.id)}
						{@const resolution = gateResolutions[pitch.id]}
						{@const workspace = workspaces.find((candidate) => candidate.pitchId === pitch.id)}
						<article class="pitch-card pitch-card--{resolution ?? 'open'}">
							<div class="pitch-card__topline">
								<span>{pitch.beat}</span>
								<span class="confidence">
									{resolutionLabel(resolution) ?? pitch.confidenceLabel} · {pitch.confidence}%
								</span>
							</div>
							<h3>{pitch.title}</h3>
							<p>{pitch.angle}</p>
							<div class="pitch-card__why">{pitch.whyNow}</div>
							{#if pitch.sources.length}
								<div class="source-strip" aria-label="Sources">
									{#each pitch.sources.slice(0, 3) as source (source.id)}
										<a href={source.url} target="_blank" rel="noreferrer">
											<span>{source.name}</span>
											<small>{sourceHost(source.url)}</small>
										</a>
									{/each}
									{#if pitch.sources.length > 3}
										<span class="source-strip__more">+{pitch.sources.length - 3}</span>
									{/if}
								</div>
							{/if}
							<div class="pitch-card__actions">
								{#if workspace}
									<button type="button" onclick={() => selectWorkspace(workspace)}>Open workspace</button>
								{:else}
									<button type="button" onclick={() => resolveGate(pitch, 'accepted')}>Accept</button>
								{/if}
								<button type="button" class="button-secondary" onclick={() => resolveGate(pitch, 'held')}>Hold</button>
								<button type="button" class="button-secondary" onclick={() => resolveGate(pitch, 'spiked')}>Spike</button>
								<a href={`/missions?mission=${encodeURIComponent(pitch.beat)}`}>Open beat</a>
							</div>
						</article>
					{/each}
				</div>
			{:else}
				<div class="empty-panel">
					<strong>No story leads yet.</strong>
					<span>Add a beat or run a source check; useful findings will show up here.</span>
				</div>
			{/if}
		</section>

		<aside class="newsroom-side" aria-label="Newsroom activity">
			<section class="side-panel">
				<div class="section-head section-head--compact">
					<div>
						<div class="panel-eyebrow">Active Story Workspaces</div>
						<h2>In progress</h2>
					</div>
				</div>
				{#if workspaces.length}
					<div class="workspace-list">
						{#each workspaces as workspace (workspace.id)}
							<button
								type="button"
								class="workspace-card"
								class:workspace-card--selected={selectedWorkspace?.id === workspace.id}
								onclick={() => selectWorkspace(workspace)}
							>
								<strong>{workspace.title}</strong>
								<span>{workspace.beat} · opened {relativeTime(workspace.createdAt)}</span>
							</button>
						{/each}
					</div>
				{:else}
					<div class="empty-panel empty-panel--small">
						<strong>No active workspaces.</strong>
						<span>Accept a pitch to seed the draft workflow.</span>
					</div>
				{/if}
			</section>

			<section class="side-panel">
				<div class="section-head section-head--compact">
					<div>
						<div class="panel-eyebrow">Standing Briefs</div>
						<h2>Beat monitors</h2>
					</div>
				</div>
				{#if standingBriefs.length}
					<div class="brief-list">
						{#each standingBriefs as brief (brief.id)}
							<a href={`/missions?mission=${encodeURIComponent(brief.name)}`} class="brief-row">
								<span>{brief.name}</span>
								<small>{brief.scheduleDisplay}</small>
							</a>
						{/each}
						{#if pausedBriefs}
							<div class="brief-row brief-row--muted">
								<span>{pausedBriefs} paused</span>
								<small>Hidden from monitor flow</small>
							</div>
						{/if}
					</div>
				{:else}
					<div class="empty-panel empty-panel--small">
						<strong>No active briefs.</strong>
						<span>Configure the sources a beat should watch.</span>
					</div>
				{/if}
			</section>
		</aside>
	</div>

	{#if selectedWorkspace}
		<section class="story-workspace" aria-labelledby="story-workspace-title">
			<div class="section-head">
				<div>
					<div class="panel-eyebrow">Story Workspace</div>
					<h2 id="story-workspace-title">{selectedWorkspace.title}</h2>
				</div>
				<div class="workspace-status">
					<span>{selectedWorkspace.beat}</span>
					<span>{selectedWorkspace.confidenceLabel}</span>
					<span>{selectedWorkspace.sources.length} sources</span>
				</div>
			</div>

			<div class="story-workspace__split">
				<section class="workspace-pane" aria-labelledby="fact-ledger-title">
					<div class="workspace-pane__head">
						<h3 id="fact-ledger-title">Fact ledger</h3>
						<span>{selectedWorkspace.factLedger.length} facts</span>
					</div>
					{#if selectedWorkspace.factLedger.length}
						<div class="fact-ledger">
							{#each selectedWorkspace.factLedger as fact (fact.id)}
								<div class="fact-row">
									<strong>{fact.label}</strong>
									<span>{fact.detail}</span>
									{#if fact.sourceUrl}
										<a href={fact.sourceUrl} target="_blank" rel="noreferrer">
											{fact.sourceName || sourceHost(fact.sourceUrl)}
										</a>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div class="empty-panel empty-panel--small">
							<strong>Ledger is ready.</strong>
							<span>Research notes from the accepted pitch will land here.</span>
						</div>
					{/if}
					{#if selectedWorkspace.sources.length}
						<div class="source-strip source-strip--workspace" aria-label="Workspace sources">
							{#each selectedWorkspace.sources as source (source.id)}
								<a href={source.url} target="_blank" rel="noreferrer">
									<span>{source.name}</span>
									<small>{sourceHost(source.url)}</small>
								</a>
							{/each}
						</div>
					{/if}
				</section>

				<section class="workspace-pane workspace-pane--draft" aria-labelledby="draft-canvas-title">
					<div class="workspace-pane__head">
						<h3 id="draft-canvas-title">Draft canvas</h3>
						<span>Active</span>
					</div>
					<div class="draft-canvas">
						<strong>{selectedWorkspace.title}</strong>
						<p class="draft-canvas__prose">
							{#each selectedDraftSegments as segment, index (segment.kind === 'citation' ? `citation-${segment.marker}-${index}` : `text-${index}`)}
								{#if segment.kind === 'citation'}
									<button
										type="button"
										class:active={selectedCitation?.marker === segment.marker}
										aria-label={`Open source details for citation ${segment.marker}`}
										onclick={() => (selectedCitationMarker = segment.marker)}
									>
										{segment.label}
									</button>
								{:else}
									{segment.text}
								{/if}
							{/each}
						</p>
						<p>{selectedWorkspace.angle}</p>
						<div>{selectedWorkspace.whyNow}</div>
						{#if selectedCitation}
							<aside class="citation-inspector" aria-label={`Citation ${selectedCitation.marker} source details`}>
								<div>
									<span>Citation [{selectedCitation.marker}]</span>
									<strong>{selectedCitation.sourceTitle}</strong>
								</div>
								<p>{selectedCitation.claim}</p>
								<div class="citation-inspector__links">
									<a href={selectedCitation.sourceUrl} target="_blank" rel="noreferrer">
										Original source
									</a>
									<a href={selectedCitation.archiveUrl} target="_blank" rel="noreferrer">
										Archive fallback
									</a>
								</div>
								{#if selectedCitation.contentHash}
									<small>Hash {selectedCitation.contentHash}</small>
								{/if}
							</aside>
						{/if}
					</div>
				</section>
			</div>

			<section class="workspace-wire" aria-labelledby="workspace-wire-title">
				<div class="workspace-pane__head">
					<h3 id="workspace-wire-title">Event Wire</h3>
					<span>{selectedWorkspaceRuns.length ? 'Live agent activity' : 'Awaiting agent activity'}</span>
				</div>
				{#if selectedWorkspaceWire.length}
					<div class="wire-list wire-list--workspace">
						{#each selectedWorkspaceWire as item (item.id)}
							<div class="wire-item wire-item--{item.tone}">
								<span class="wire-item__kind">{item.kind}</span>
								<strong>{item.label}</strong>
								<span>{item.detail}</span>
								<time>{relativeTime(item.at)}</time>
							</div>
						{/each}
					</div>
				{:else}
					<div class="empty-panel empty-panel--small">
						<strong>No workspace events yet.</strong>
						<span>Accepted pitch activity will appear here.</span>
					</div>
				{/if}
			</section>
		</section>
	{/if}

	<section class="wire" aria-labelledby="wire-title">
		<div class="section-head">
			<div>
				<div class="panel-eyebrow">Wire</div>
				<h2 id="wire-title">Agent activity</h2>
			</div>
		</div>
		{#if wireItems.length}
			<div class="wire-list">
				{#each wireItems as item (item.id)}
					<div class="wire-item wire-item--{item.tone}">
						<span class="wire-item__kind">{item.kind}</span>
						<strong>{item.label}</strong>
						<span>{item.detail}</span>
						<time>{relativeTime(item.at)}</time>
					</div>
				{/each}
			</div>
		{:else}
			<div class="empty-panel">
				<strong>The Wire is quiet.</strong>
				<span>Monitor runs, source checks, and pitch gates will appear here.</span>
			</div>
		{/if}
	</section>
</div>

<style>
	.newsroom {
		display: grid;
		gap: var(--space-6);
		padding: var(--space-6);
		color: var(--fg-1);
	}

	.newsroom-hero {
		display: grid;
		grid-template-columns: minmax(18rem, 0.8fr) minmax(22rem, 1fr);
		gap: var(--space-8);
		align-items: end;
		padding: var(--space-6) 0 var(--space-5);
		border-top: 2px solid var(--ink-900);
		border-bottom: 1px solid var(--border-soft);
	}

	.newsroom-hero__eyebrow,
	.panel-eyebrow {
		font-family: var(--font-mono);
		color: var(--fg-3);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		letter-spacing: var(--tr-meta);
		text-transform: uppercase;
	}

	.newsroom-hero h1,
	.section-head h2 {
		margin: 0;
		color: var(--fg-1);
		font-family: var(--font-display);
		letter-spacing: 0;
	}

	.newsroom-hero h1 {
		margin-top: var(--space-2);
		font-size: var(--fs-h1);
		line-height: var(--lh-h1);
		max-width: 18ch;
	}

	.newsroom-hero p {
		max-width: 42rem;
		margin: var(--space-3) 0 0;
		color: var(--fg-2);
		font-size: var(--fs-body-lg);
		line-height: var(--lh-body-lg);
	}

	.newsroom-hero__meta {
		display: grid;
		grid-template-columns: repeat(3, minmax(6.5rem, 1fr));
		gap: var(--space-2);
	}

	.newsroom-hero__meta div {
		padding: var(--space-4);
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
	}

	.newsroom-hero__meta strong {
		display: block;
		font-family: var(--font-display);
		font-size: var(--fs-h3);
		line-height: 1;
	}

	.newsroom-hero__meta span {
		display: block;
		margin-top: var(--space-2);
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		letter-spacing: var(--tr-meta);
		text-transform: uppercase;
	}

	.command-panel,
	.open-gates,
	.pitch-queue,
	.side-panel,
	.story-workspace,
	.wire {
		border: 1px solid var(--border-default);
		background: var(--bg-surface);
		box-shadow: var(--shadow-1);
	}

	.command-panel {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-5);
	}

	.command-panel__copy p {
		margin: var(--space-1) 0 0;
		color: var(--fg-2);
	}

	.command-panel__prompts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.command-panel__prompts button,
	.pitch-card__actions button,
	.pitch-card__actions a,
	.section-head a {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
		color: var(--fg-1);
		font-family: var(--font-body);
		font-size: var(--fs-body-sm);
		font-weight: var(--fw-semibold);
		padding: 7px 10px;
		text-decoration: none;
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std);
	}

	.command-panel__prompts button:hover,
	.pitch-card__actions .button-secondary:hover,
	.pitch-card__actions a:hover,
	.section-head a:hover {
		background: var(--bg-raised);
		border-color: var(--border-strong);
	}

	.command-panel__status {
		display: grid;
		gap: var(--space-1);
		border-left: 3px solid var(--accent);
		background: var(--accent-soft);
		padding: var(--space-3);
	}

	.command-panel__status--warning {
		border-left-color: var(--caution-500);
		background: var(--status-review-bg);
	}

	.command-panel__status span,
	.command-panel__status small {
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		letter-spacing: var(--tr-meta);
		text-transform: uppercase;
	}

	.command-panel__status strong {
		color: var(--fg-1);
		font-size: var(--fs-body-sm);
		line-height: var(--lh-body);
	}

	.pitch-card__actions button:not(.button-secondary) {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--fg-on-accent);
	}

	.pitch-card__actions button:not(.button-secondary):hover {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
	}

	.newsroom-alert {
		display: flex;
		gap: var(--space-2);
		align-items: center;
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border-default);
		border-left: 3px solid var(--accent);
		background: var(--accent-soft);
		color: var(--accent-fg);
	}

	.newsroom-alert span {
		color: var(--fg-2);
	}

	.newsroom-alert--warning {
		background: var(--status-review-bg);
		border-color: var(--caution-500);
		color: var(--status-review-fg);
	}

	.newsroom-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 0.7fr);
		gap: var(--space-4);
		align-items: start;
	}

	.pitch-queue,
	.open-gates,
	.side-panel,
	.story-workspace,
	.wire {
		padding: var(--space-5);
	}

	.story-workspace {
		display: grid;
		gap: var(--space-5);
	}

	.newsroom-side {
		display: grid;
		gap: var(--space-4);
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-4);
	}

	.section-head h2 {
		margin-top: var(--space-1);
		font-size: var(--fs-h2);
		line-height: var(--lh-h2);
	}

	.section-head--compact {
		margin-bottom: var(--space-3);
	}

	.section-head--compact h2 {
		font-size: var(--fs-h4);
		line-height: var(--lh-h4);
	}

	.section-head a {
		white-space: nowrap;
	}

	.pitch-list,
	.open-gates__list,
	.workspace-list,
	.brief-list,
	.wire-list {
		display: grid;
		gap: var(--space-3);
	}

	.pitch-card {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border-default);
		border-top: 2px solid var(--ink-900);
		background: var(--bg-surface);
	}

	.pitch-card--accepted {
		border-top-color: var(--status-verified);
		background: color-mix(in srgb, var(--status-verified-bg) 40%, var(--bg-surface));
	}

	.pitch-card--held {
		border-top-color: var(--status-review);
		background: color-mix(in srgb, var(--status-review-bg) 44%, var(--bg-surface));
	}

	.pitch-card__topline,
	.pitch-card__why {
		display: flex;
		justify-content: space-between;
		gap: var(--space-4);
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		letter-spacing: var(--tr-meta);
		text-transform: uppercase;
	}

	.confidence {
		color: var(--accent-fg);
	}

	.pitch-card h3 {
		margin: 0;
		color: var(--fg-1);
		font-family: var(--font-display);
		font-size: var(--fs-h4);
		line-height: var(--lh-h4);
		letter-spacing: 0;
	}

	.pitch-card p {
		margin: 0;
		color: var(--fg-2);
		line-height: var(--lh-body);
	}

	.source-strip {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.source-strip a,
	.source-strip__more,
	.brief-row,
	.workspace-card,
	.wire-item {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
	}

	.source-strip a {
		display: grid;
		min-width: min(100%, 11rem);
		padding: var(--space-2) var(--space-3);
		color: var(--fg-1);
		text-decoration: none;
	}

	.source-strip span,
	.source-strip small,
	.brief-row span,
	.brief-row small,
	.workspace-card span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.source-strip small,
	.brief-row small,
	.workspace-card span {
		color: var(--fg-3);
		font-size: var(--fs-body-sm);
	}

	.source-strip__more {
		display: grid;
		place-items: center;
		padding: 0 var(--space-3);
		color: var(--fg-3);
		font-weight: var(--fw-semibold);
	}

	.pitch-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.pitch-card__actions a {
		background: transparent;
		color: var(--fg-1);
	}

	.empty-panel {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-5);
		border: 1px dashed var(--border-strong);
		color: var(--fg-1);
	}

	.empty-panel span {
		color: var(--fg-2);
	}

	.empty-panel--small {
		padding: var(--space-3);
	}

	.workspace-card,
	.brief-row {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		color: var(--fg-1);
		text-decoration: none;
	}

	button.workspace-card {
		width: 100%;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.workspace-card--selected {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.workspace-status {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.workspace-status span,
	.workspace-pane__head span {
		border: 1px solid var(--border-soft);
		border-radius: 999px;
		background: var(--bg-raised);
		color: var(--fg-2);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		letter-spacing: var(--tr-meta);
		padding: 3px 7px;
		text-transform: uppercase;
	}

	.story-workspace__split {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: var(--space-4);
	}

	.workspace-pane,
	.workspace-wire {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		padding: var(--space-4);
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
	}

	.workspace-pane__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.workspace-pane__head h3 {
		margin: 0;
		color: var(--fg-1);
		font-family: var(--font-display);
		font-size: var(--fs-h4);
		letter-spacing: 0;
	}

	.fact-ledger {
		display: grid;
		gap: var(--space-2);
	}

	.fact-row {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--border-soft);
		background: var(--bg-surface);
	}

	.fact-row strong {
		color: var(--fg-1);
	}

	.fact-row span {
		color: var(--fg-2);
		line-height: var(--lh-body);
	}

	.fact-row a {
		color: var(--accent-fg);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		text-decoration: none;
		text-transform: uppercase;
	}

	.source-strip--workspace {
		padding-top: var(--space-1);
	}

	.draft-canvas {
		display: grid;
		gap: var(--space-3);
		align-content: start;
		min-height: 16rem;
		padding: var(--space-4);
		border: 1px solid var(--border-soft);
		background: var(--bg-raised);
		color: var(--fg-2);
		line-height: var(--lh-body);
	}

	.draft-canvas strong {
		color: var(--fg-1);
		font-family: var(--font-display);
		font-size: var(--fs-h4);
		line-height: var(--lh-h4);
	}

	.draft-canvas p {
		margin: 0;
	}

	.draft-canvas__prose button {
		display: inline-flex;
		align-items: center;
		min-width: 1.9rem;
		min-height: 1.5rem;
		margin: 0 0.1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--accent-fg);
		cursor: pointer;
		font: inherit;
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-semibold);
		justify-content: center;
		padding: 0 0.25rem;
		vertical-align: baseline;
	}

	.draft-canvas__prose button:hover,
	.draft-canvas__prose button.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--fg-1);
	}

	.draft-canvas > div {
		padding-top: var(--space-3);
		border-top: 1px solid var(--border-soft);
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-body-sm);
		font-weight: var(--fw-medium);
	}

	.citation-inspector {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--border-default);
		border-left: 3px solid var(--accent);
		background: var(--bg-surface);
		color: var(--fg-2);
	}

	.citation-inspector div {
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
	}

	.citation-inspector span,
	.citation-inspector small {
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		text-transform: uppercase;
	}

	.citation-inspector strong {
		display: block;
		margin-top: var(--space-1);
		font-family: var(--font-body);
		font-size: var(--fs-body);
		line-height: var(--lh-body);
	}

	.citation-inspector__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.citation-inspector__links a {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		color: var(--accent-fg);
		font-size: var(--fs-body-sm);
		font-weight: var(--fw-semibold);
		padding: 0.35rem 0.5rem;
		text-decoration: none;
	}

	.brief-row--muted {
		color: var(--fg-3);
	}

	.wire-item {
		display: grid;
		grid-template-columns: 8rem minmax(8rem, 0.45fr) minmax(0, 1fr) auto;
		gap: var(--space-3);
		align-items: center;
		padding: var(--space-3);
		color: var(--fg-2);
	}

	.wire-item--active {
		border-color: var(--status-verified);
		background: color-mix(in srgb, var(--status-verified-bg) 42%, var(--bg-surface));
	}

	.wire-item--warning {
		border-color: var(--status-review);
		background: color-mix(in srgb, var(--status-review-bg) 48%, var(--bg-surface));
	}

	.wire-item__kind {
		color: var(--accent-fg);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		letter-spacing: var(--tr-meta);
		text-transform: uppercase;
	}

	.wire-item strong {
		color: var(--fg-1);
	}

	.wire-item time {
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		white-space: nowrap;
	}

	@media (max-width: 980px) {
		.newsroom-hero,
		.newsroom-grid,
		.story-workspace__split {
			grid-template-columns: 1fr;
		}

		.newsroom-hero__meta {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.wire-item {
			grid-template-columns: 1fr;
			gap: var(--space-1);
		}
	}

	@media (max-width: 640px) {
		.newsroom {
			padding: var(--space-3);
			gap: var(--space-4);
		}

		.newsroom-hero {
			padding-top: var(--space-4);
		}

		.newsroom-hero h1 {
			font-size: 36px;
		}

		.newsroom-hero__meta {
			grid-template-columns: 1fr;
		}

		.newsroom-alert {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
