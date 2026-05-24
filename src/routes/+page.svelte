<script lang="ts">
	import { replaceState } from '$app/navigation';
	import Composer from '$lib/components/Composer.svelte';
	import type { AgentJob, AgentRun, BoardData, BoardPost, ChannelSource } from '$lib/types';
	import { onMount } from 'svelte';

	let {
		data
	}: {
		data: {
			board: BoardData | null;
			boardError: string | null;
			missionsEnabled: boolean;
		};
	} = $props();

	let composer: Composer | undefined = $state();

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
	const standingBriefs = $derived((board?.jobs ?? []).filter((job) => job.enabled).slice(0, 4));
	const pausedBriefs = $derived((board?.jobs ?? []).filter((job) => !job.enabled).length);
	const activeWorkspaces = $derived(
		(board?.runs ?? [])
			.filter((run) => ['queued', 'running'].includes(run.status))
			.sort((a, b) => timestampMs(b.latestActivityAt ?? b.startedAt ?? b.queuedAt) - timestampMs(a.latestActivityAt ?? a.startedAt ?? a.queuedAt))
			.slice(0, 3)
	);
	const wireItems = $derived(wireFromBoard(board));

	onMount(() => {
		const draft = new URL(location.href).searchParams.get('draft');
		if (!draft) return;
		composer?.setValue(draft);
		replaceState('/', {});
	});

	interface Pitch {
		id: string;
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

	function pitchFromPost(post: BoardPost, job: AgentJob | undefined): Pitch {
		const sources = (job?.sources ?? []).filter((source) => source.enabled !== false);
		const report = post.responseMarkdown || post.preview || '';
		const angle = extractAngle(report, post.preview);
		const confidence = confidenceFor(post, job, sources);
		return {
			id: post.id,
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

	function spawnWorkspace(pitch: Pitch) {
		const sourceLines = pitch.sources.length
			? pitch.sources.map((source, index) => `${index + 1}. ${source.name}: ${source.url}`).join('\n')
			: 'No configured source list was attached; ask the monitor to fetch supporting sources first.';
		composer?.setValue(`Start a story draft from this lead.

Beat: ${pitch.beat}
Lead: ${pitch.title}
Why now: ${pitch.whyNow}
Suggested angle: ${pitch.angle}

Use a 300-word web story format. Build a fact ledger first, cite every draft sentence, and use only the source-backed facts from this pitch.

Sources:
${sourceLines}`);
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
				<strong>{pitches.length}</strong>
				<span>new leads</span>
			</div>
			<div>
				<strong>{standingBriefs.length}</strong>
				<span>beats watched</span>
			</div>
			<div>
				<strong>{activeWorkspaces.length}</strong>
				<span>runs active</span>
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
		<Composer bind:this={composer} placeholder="Ask for leads, paste a source URL, or draft from a lead..." />
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

	<div class="newsroom-grid">
		<section class="pitch-queue" aria-labelledby="pitch-queue-title">
			<div class="section-head">
				<div>
					<div class="panel-eyebrow">Story leads</div>
					<h2 id="pitch-queue-title">What looks worth chasing</h2>
				</div>
				<a href="/missions?new=1">Manage beats</a>
			</div>

			{#if pitches.length}
				<div class="pitch-list">
					{#each pitches as pitch (pitch.id)}
						<article class="pitch-card">
							<div class="pitch-card__topline">
								<span>{pitch.beat}</span>
								<span class="confidence">{pitch.confidenceLabel} · {pitch.confidence}%</span>
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
								<button type="button" onclick={() => spawnWorkspace(pitch)}>Start draft</button>
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
				{#if activeWorkspaces.length}
					<div class="workspace-list">
						{#each activeWorkspaces as run (run.id)}
							<div class="workspace-card">
								<strong>{run.jobName || 'Beat monitor'}</strong>
								<span>{run.status} · {relativeTime(run.latestActivityAt ?? run.startedAt ?? run.queuedAt)}</span>
							</div>
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
		gap: 1rem;
		padding: clamp(1rem, 2vw, 1.75rem);
		color: var(--color-text, #17130f);
	}

	.newsroom-hero,
	.command-panel,
	.pitch-queue,
	.side-panel,
	.wire,
	.newsroom-alert {
		border: 1px solid rgba(31, 27, 22, 0.12);
		background:
			linear-gradient(135deg, rgba(255, 252, 244, 0.96), rgba(247, 239, 222, 0.78)),
			var(--color-surface, #fffaf0);
		border-radius: 28px;
		box-shadow: 0 18px 60px rgba(58, 45, 23, 0.08);
	}

	.newsroom-hero {
		display: grid;
		grid-template-columns: minmax(18rem, 0.8fr) minmax(22rem, 1fr);
		gap: 1.5rem;
		align-items: center;
		padding: clamp(1.25rem, 3vw, 2rem);
		overflow: hidden;
		position: relative;
	}

	.newsroom-hero::after {
		content: '';
		position: absolute;
		inset: auto -8rem -8rem auto;
		width: 18rem;
		height: 18rem;
		border-radius: 999px;
		background: radial-gradient(circle, rgba(219, 98, 42, 0.22), transparent 68%);
		pointer-events: none;
	}

	.newsroom-hero__eyebrow,
	.panel-eyebrow {
		color: #8a4b22;
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.newsroom-hero h1,
	.section-head h2 {
		margin: 0;
		color: #21180f;
		letter-spacing: -0.04em;
	}

	.newsroom-hero h1 {
		margin-top: 0.35rem;
		font-size: clamp(2rem, 4vw, 3.4rem);
		line-height: 0.98;
		max-width: 16ch;
	}

	.newsroom-hero p {
		max-width: 42rem;
		margin: 0.75rem 0 0;
		color: rgba(33, 24, 15, 0.68);
		font-size: 1rem;
		line-height: 1.65;
	}

	.newsroom-hero__meta {
		display: grid;
		grid-template-columns: repeat(3, minmax(6.5rem, 1fr));
		gap: 0.6rem;
		position: relative;
		z-index: 1;
	}

	.newsroom-hero__meta div {
		padding: 0.9rem;
		border: 1px solid rgba(33, 24, 15, 0.1);
		border-radius: 20px;
		background: rgba(255, 255, 255, 0.54);
	}

	.newsroom-hero__meta strong {
		display: block;
		font-size: 1.65rem;
		line-height: 1;
	}

	.newsroom-hero__meta span {
		display: block;
		margin-top: 0.35rem;
		color: rgba(33, 24, 15, 0.58);
		font-size: 0.76rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.command-panel {
		display: grid;
		gap: 0.9rem;
		padding: 1rem;
	}

	.command-panel__copy p {
		margin: 0.2rem 0 0;
		color: rgba(33, 24, 15, 0.64);
	}

	.command-panel__prompts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.command-panel__prompts button,
	.pitch-card__actions button,
	.pitch-card__actions a,
	.section-head a {
		border: 1px solid rgba(33, 24, 15, 0.14);
		border-radius: 999px;
		background: #21180f;
		color: #fff9ef;
		font: inherit;
		font-size: 0.82rem;
		font-weight: 800;
		padding: 0.55rem 0.85rem;
		text-decoration: none;
		cursor: pointer;
	}

	.command-panel__prompts button {
		background: rgba(255, 255, 255, 0.62);
		color: #3a2a19;
	}

	.newsroom-alert {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.9rem 1rem;
		color: #4b321d;
	}

	.newsroom-alert span {
		color: rgba(75, 50, 29, 0.7);
	}

	.newsroom-alert--warning {
		background: #fff3df;
		border-color: rgba(185, 89, 32, 0.24);
	}

	.newsroom-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 0.7fr);
		gap: 1rem;
		align-items: start;
	}

	.pitch-queue,
	.side-panel,
	.wire {
		padding: 1rem;
	}

	.newsroom-side {
		display: grid;
		gap: 1rem;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.section-head h2 {
		margin-top: 0.15rem;
		font-size: clamp(1.45rem, 2vw, 2rem);
	}

	.section-head--compact {
		margin-bottom: 0.75rem;
	}

	.section-head--compact h2 {
		font-size: 1.1rem;
	}

	.section-head a {
		background: rgba(255, 255, 255, 0.66);
		color: #3a2a19;
		white-space: nowrap;
	}

	.pitch-list,
	.workspace-list,
	.brief-list,
	.wire-list {
		display: grid;
		gap: 0.75rem;
	}

	.pitch-card {
		display: grid;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid rgba(33, 24, 15, 0.1);
		border-radius: 22px;
		background: rgba(255, 255, 255, 0.58);
	}

	.pitch-card__topline,
	.pitch-card__why {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		color: rgba(33, 24, 15, 0.58);
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.confidence {
		color: #a14e1d;
	}

	.pitch-card h3 {
		margin: 0;
		color: #21180f;
		font-size: clamp(1.25rem, 2vw, 1.8rem);
		line-height: 1.08;
		letter-spacing: -0.03em;
	}

	.pitch-card p {
		margin: 0;
		color: rgba(33, 24, 15, 0.68);
		line-height: 1.55;
	}

	.source-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.source-strip a,
	.source-strip__more,
	.brief-row,
	.workspace-card,
	.wire-item {
		border: 1px solid rgba(33, 24, 15, 0.1);
		border-radius: 16px;
		background: rgba(255, 255, 255, 0.58);
	}

	.source-strip a {
		display: grid;
		min-width: min(100%, 11rem);
		padding: 0.6rem 0.7rem;
		color: #281c11;
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
		color: rgba(33, 24, 15, 0.54);
		font-size: 0.76rem;
	}

	.source-strip__more {
		display: grid;
		place-items: center;
		padding: 0 0.75rem;
		color: rgba(33, 24, 15, 0.58);
		font-weight: 800;
	}

	.pitch-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.pitch-card__actions a {
		background: transparent;
		color: #3a2a19;
	}

	.empty-panel {
		display: grid;
		gap: 0.35rem;
		padding: 1.2rem;
		border: 1px dashed rgba(33, 24, 15, 0.22);
		border-radius: 22px;
		color: #3a2a19;
	}

	.empty-panel span {
		color: rgba(33, 24, 15, 0.62);
	}

	.empty-panel--small {
		padding: 0.9rem;
	}

	.workspace-card,
	.brief-row {
		display: grid;
		gap: 0.25rem;
		padding: 0.75rem;
		color: #281c11;
		text-decoration: none;
	}

	.brief-row--muted {
		color: rgba(33, 24, 15, 0.56);
	}

	.wire-item {
		display: grid;
		grid-template-columns: 8rem minmax(8rem, 0.45fr) minmax(0, 1fr) auto;
		gap: 0.75rem;
		align-items: center;
		padding: 0.75rem;
		color: rgba(33, 24, 15, 0.7);
	}

	.wire-item--active {
		border-color: rgba(62, 112, 72, 0.24);
		background: rgba(235, 249, 232, 0.58);
	}

	.wire-item--warning {
		border-color: rgba(185, 89, 32, 0.24);
		background: rgba(255, 243, 223, 0.68);
	}

	.wire-item__kind {
		color: #8a4b22;
		font-size: 0.74rem;
		font-weight: 900;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.wire-item strong {
		color: #21180f;
	}

	.wire-item time {
		color: rgba(33, 24, 15, 0.48);
		font-size: 0.78rem;
		font-weight: 800;
		white-space: nowrap;
	}

	@media (max-width: 980px) {
		.newsroom-hero,
		.newsroom-grid {
			grid-template-columns: 1fr;
		}

		.newsroom-hero__meta {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.wire-item {
			grid-template-columns: 1fr;
			gap: 0.35rem;
		}
	}

	@media (max-width: 640px) {
		.newsroom {
			padding: 0.75rem;
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
