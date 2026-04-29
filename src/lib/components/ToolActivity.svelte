<script lang="ts">
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import { chat } from '$lib/stores/chat.svelte';
	import {
		dominantDoneLabel,
		dominantLiveLabel,
		formatElapsed,
		showToolRawName,
		toolStepDetail,
		toolStepLabel
	} from '$lib/utils/tool-labels';

	interface Props {
		// True when this card is attached to the current assistant turn. It stays
		// true after streaming finishes so the per-turn recap remains visible.
		activeTurn: boolean;
	}
	let { activeTurn }: Props = $props();

	const ELAPSED_VISIBLE_MS = 5_000;
	const RECOVERY_AFTER_MS = 30_000;

	let now = $state(Date.now());
	let expanded = $state(true);
	let recoveryDismissed = $state(false);

	$effect(() => {
		const live = chat.tools.length > 0 || (activeTurn && chat.streaming);
		if (!live) return;
		const i = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(i);
	});

	// When a fresh stream starts, re-arm the recovery banner.
	$effect(() => {
		if (chat.streamStartedAt != null) {
			recoveryDismissed = false;
		}
	});

	const hasRunning = $derived(chat.tools.length > 0);
	const hasFinished = $derived(chat.toolHistory.length > 0);
	const hasSources = $derived(chat.sources.length > 0);
	const liveNames = $derived(chat.tools.map((t) => t.name));
	const finishedNames = $derived(chat.toolHistory.map((t) => t.name));

	const oldestStart = $derived.by(() => {
		if (chat.tools.length === 0) return chat.streamStartedAt ?? Date.now();
		return chat.tools.reduce(
			(min, t) => (t.startedAt < min ? t.startedAt : min),
			chat.tools[0].startedAt
		);
	});
	const elapsedMs = $derived(Math.max(0, now - oldestStart));
	const showElapsed = $derived(hasRunning && elapsedMs >= ELAPSED_VISIBLE_MS);
	const showRecovery = $derived(
		hasRunning && elapsedMs >= RECOVERY_AFTER_MS && !recoveryDismissed
	);

	const liveText = $derived(dominantLiveLabel(liveNames));
	const doneText = $derived(dominantDoneLabel(finishedNames));
	const latestTool = $derived.by(() => {
		if (chat.tools.length > 0) return chat.tools[chat.tools.length - 1];
		if (chat.toolHistory.length > 0) return chat.toolHistory[chat.toolHistory.length - 1];
		return null;
	});
	const headDetail = $derived(latestTool ? toolStepDetail(latestTool) : '');

	// Visible while: actively streaming, tools running, or recap from this turn
	// is still attached. After endStream() finalizes, the recap stays until the
	// next startStream() resets toolHistory.
	const visible = $derived(
		hasRunning ||
			(activeTurn && chat.streaming) ||
			(activeTurn && hasSources) ||
			(activeTurn && hasFinished)
	);

	const headLabel = $derived.by(() => {
		if (hasRunning && latestTool) return toolStepLabel(latestTool);
		if (hasRunning) return liveText;
		if (activeTurn && chat.streaming) return 'Drafting answer';
		if (hasFinished) {
			return `${chat.toolHistory.length} ${chat.toolHistory.length === 1 ? 'step' : 'steps'} completed`;
		}
		if (doneText) return doneText;
		return '';
	});

	function toggle() {
		expanded = !expanded;
	}

	function keepWaiting() {
		recoveryDismissed = true;
	}

	function answerWithWhatWeHave() {
		recoveryDismissed = true;
		chat.cancel('partial');
	}

	function stop() {
		recoveryDismissed = true;
		chat.cancel();
	}

	function elapsedFor(t: { startedAt: number }): string {
		return formatElapsed(now - t.startedAt);
	}
</script>

{#if visible}
	<div class="tool-activity" class:tool-activity--idle={!hasRunning} role="status" aria-live="polite">
		<button
			type="button"
			class="tool-activity__head"
			onclick={toggle}
			aria-expanded={expanded}
			aria-label={expanded ? 'Hide tool details' : 'Show tool details'}
		>
			{#if hasRunning || (activeTurn && chat.streaming)}
				<span class="pulse__dots tool-activity__dots" aria-hidden="true"
					><span></span><span></span><span></span></span
				>
			{:else}
				<span class="tool-activity__check" aria-hidden="true">✓</span>
			{/if}
			<span class="tool-activity__label">{headLabel}</span>
			{#if headDetail}
				<span class="tool-activity__headline-detail">{headDetail}</span>
			{/if}
			{#if hasRunning && chat.tools.length > 1}
				<span class="tool-activity__count">· {chat.tools.length} tools</span>
			{/if}
			{#if showElapsed}
				<span class="tool-activity__elapsed">{formatElapsed(elapsedMs)}</span>
			{/if}
			<ChevronRight
				class="tool-activity__chev {expanded ? 'tool-activity__chev--open' : ''}"
				size="12"
				strokeWidth={1.75}
			/>
		</button>

		{#if hasSources}
			<div class="tool-activity__sources" aria-label="Sources">
				{#each chat.sources as source (source.id)}
					<a class="tool-source" href={source.url} target="_blank" rel="noopener noreferrer">
						<span class="tool-source__status">{source.status}</span>
						<span class="tool-source__main">
							<span class="tool-source__title">{source.title}</span>
							<span class="tool-source__domain">{source.domain}</span>
							{#if source.detail}
								<span class="tool-source__detail">{source.detail}</span>
							{/if}
						</span>
					</a>
				{/each}
			</div>
		{/if}

		{#if expanded && (hasRunning || hasFinished)}
			<div class="tool-activity__body">
				{#if hasRunning}
					<div class="tool-activity__sub">Running</div>
					<ul class="tool-activity__list">
						{#each chat.tools as t, i (t.id)}
							{@const detail = toolStepDetail(t)}
							<li>
								<span class="tool-activity__step-index">{i + 1}</span>
								<span class="tool-activity__step-main">
									<span class="tool-activity__step-row">
										<span class="tool-activity__name">{toolStepLabel(t)}</span>
										{#if showToolRawName(t)}
											<span class="tool-activity__rawname">{t.name}</span>
										{/if}
									</span>
									{#if detail}
										<span class="tool-activity__step-detail">{detail}</span>
									{/if}
								</span>
								<span class="tool-activity__elapsed">{elapsedFor(t)}</span>
							</li>
						{/each}
					</ul>
				{/if}
				{#if hasFinished}
					<div class="tool-activity__sub">Completed</div>
					<ul class="tool-activity__list tool-activity__list--done">
						{#each chat.toolHistory as t, i (t.id)}
							{@const detail = toolStepDetail(t)}
							<li>
								<span class="tool-activity__step-index">{i + 1}</span>
								<span class="tool-activity__step-main">
									<span class="tool-activity__step-row">
										<span class="tool-activity__name">{toolStepLabel(t, true)}</span>
										{#if showToolRawName(t)}
											<span class="tool-activity__rawname">{t.name}</span>
										{/if}
									</span>
									{#if detail}
										<span class="tool-activity__step-detail">{detail}</span>
									{/if}
								</span>
								<span class="tool-activity__elapsed"
									>{formatElapsed(t.finishedAt - t.startedAt)}</span
								>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		{#if showRecovery}
			<div class="tool-activity__recovery" role="alert">
				<span class="tool-activity__recovery__msg">
					This is taking longer than expected.
				</span>
				<div class="tool-activity__recovery__actions">
					<button
						type="button"
						class="tool-activity__btn tool-activity__btn--primary"
						onclick={keepWaiting}
					>
						Keep waiting
					</button>
					<button
						type="button"
						class="tool-activity__btn"
						onclick={answerWithWhatWeHave}
					>
						Answer with what we have
					</button>
					<button type="button" class="tool-activity__btn" onclick={stop}>Stop</button>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.tool-activity {
		margin-top: 8px;
		margin-bottom: 4px;
		border: 1px solid var(--border-soft);
		border-left: 3px solid var(--cobalt-500);
		background: var(--bg-surface);
		border-radius: var(--radius-1);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-2);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
	}
	.tool-activity--idle {
		border-left-color: var(--ink-300);
	}
	.tool-activity__head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		text-transform: inherit;
		letter-spacing: inherit;
		cursor: pointer;
		text-align: left;
	}
	.tool-activity__head:hover {
		background: var(--bg-raised);
	}
	.tool-activity__head:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
	.tool-activity__label {
		color: var(--fg-1);
		font-weight: 600;
		flex: 0 0 auto;
	}
	.tool-activity__headline-detail {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--fg-2);
		font-family: var(--font-body);
		font-size: 11.5px;
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
	}
	.tool-activity__count,
	.tool-activity__elapsed,
	.tool-activity__rawname {
		color: var(--fg-3);
		font-weight: 500;
	}
	.tool-activity__elapsed {
		margin-left: auto;
	}
	.tool-activity__check {
		display: inline-flex;
		width: 14px;
		height: 14px;
		align-items: center;
		justify-content: center;
		color: var(--signal-500);
		font-weight: 700;
	}
	.tool-activity__dots {
		min-width: 18px;
	}
	:global(.tool-activity__chev) {
		color: var(--fg-3);
		transition: transform var(--dur-fast) var(--ease-std);
	}
	:global(.tool-activity__chev--open) {
		transform: rotate(90deg);
	}
	.tool-activity__body {
		border-top: 1px solid var(--border-soft);
		padding: 8px 10px;
		background: var(--bg-page);
	}
	.tool-activity__sources {
		display: grid;
		gap: 4px;
		padding: 0 8px 8px;
	}
	.tool-source {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 8px;
		min-width: 0;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: var(--bg-page);
		padding: 6px 7px;
		color: inherit;
		text-decoration: none;
		text-transform: none;
		letter-spacing: 0;
		font-family: var(--font-body);
	}
	.tool-source:hover {
		border-color: var(--border-default);
		background: var(--bg-raised);
	}
	.tool-source__status {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-pill);
		padding: 1px 5px;
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--fg-3);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.tool-source__main {
		display: grid;
		gap: 1px;
		min-width: 0;
	}
	.tool-source__title,
	.tool-source__domain,
	.tool-source__detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tool-source__title {
		color: var(--fg-1);
		font-size: 12px;
		font-weight: 600;
	}
	.tool-source__domain {
		color: var(--fg-3);
		font-size: 11px;
	}
	.tool-source__detail {
		color: var(--fg-2);
		font-size: 11.5px;
	}
	.tool-activity__sub {
		font-size: 10px;
		color: var(--fg-3);
		margin-bottom: 4px;
	}
	.tool-activity__list {
		list-style: none;
		margin: 0 0 8px 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 7px;
	}
	.tool-activity__list:last-child {
		margin-bottom: 0;
	}
	.tool-activity__list li {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) auto;
		align-items: start;
		gap: 8px;
		font-size: 10.5px;
	}
	.tool-activity__step-index {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-pill);
		color: var(--fg-3);
		font-size: 9px;
		line-height: 1;
	}
	.tool-activity__step-main {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.tool-activity__step-row {
		display: flex;
		align-items: baseline;
		gap: 7px;
		min-width: 0;
	}
	.tool-activity__name {
		color: var(--fg-1);
		font-weight: 500;
		flex: 0 0 auto;
	}
	.tool-activity__list--done .tool-activity__name {
		color: var(--fg-2);
	}
	.tool-activity__rawname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tool-activity__step-detail {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--fg-2);
		font-family: var(--font-body);
		font-size: 11.5px;
		line-height: 1.35;
		text-transform: none;
		letter-spacing: 0;
	}
	.tool-activity__recovery {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		align-items: center;
		justify-content: space-between;
		padding: 6px 10px 8px;
		border-top: 1px solid var(--caution-300);
		background: var(--caution-50);
		color: var(--caution-700);
	}
	.tool-activity__recovery__msg {
		font-weight: 600;
		text-transform: none;
		letter-spacing: 0;
		font-family: var(--font-body);
		font-size: 12.5px;
	}
	.tool-activity__recovery__actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.tool-activity__btn {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 8px;
		background: transparent;
		border: 1px solid var(--caution-300);
		color: var(--caution-700);
		border-radius: var(--radius-1);
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std);
	}
	.tool-activity__btn:hover {
		background: var(--bg-surface);
	}
	.tool-activity__btn:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
	.tool-activity__btn--primary {
		background: var(--caution-500);
		color: var(--ink-0);
		border-color: var(--caution-500);
	}
	.tool-activity__btn--primary:hover {
		background: var(--caution-700);
		border-color: var(--caution-700);
		color: var(--ink-0);
	}
	@media (prefers-color-scheme: dark) {
		.tool-activity {
			background: var(--ink-800);
		}
		.tool-activity__body {
			background: var(--ink-700);
		}
		.tool-activity__recovery {
			background: var(--ink-800);
			border-color: var(--caution-500);
			color: var(--caution-300);
		}
		.tool-activity__btn {
			color: var(--caution-300);
			border-color: var(--caution-500);
		}
	}
</style>
