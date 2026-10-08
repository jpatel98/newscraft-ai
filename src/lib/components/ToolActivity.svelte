<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import type { StreamToolCall } from '$lib/utils/stream-events';
	import { dominantLiveLabel, formatElapsed, toolStepLabel, toolStepDetail, toolStepResult } from '$lib/utils/tool-labels';

	interface Props {
		// True when this card is attached to the current assistant turn.
		activeTurn: boolean;
		runState?: string | null;
		completedTools?: StreamToolCall[];
	}
	let { activeTurn, runState = null, completedTools = [] }: Props = $props();

	const ELAPSED_VISIBLE_MS = 5_000;
	const RECOVERY_AFTER_MS = 45_000;
	const RECOVERY_QUIET_MS = 15_000;

	let now = $state(Date.now());
	let recoveryDismissed = $state(false);

	$effect(() => {
		const live = activeTurn && (chat.tools.length > 0 || chat.streaming);
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

	const runningTools = $derived(activeTurn ? chat.tools.filter(tool => !['plan', 'decision'].includes(tool.name)) : []);
	const completed = $derived(completedTools.filter(tool => tool.status !== 'running' && !['plan', 'decision'].includes(tool.name)).slice(-12));
	const hasRunning = $derived(runningTools.length > 0);
	const liveNames = $derived(runningTools.map((t) => t.name));

	const oldestStart = $derived.by(() => {
		if (runningTools.length === 0) return chat.streamStartedAt ?? Date.now();
		return runningTools.reduce(
			(min, t) => (t.startedAt < min ? t.startedAt : min),
			runningTools[0].startedAt
		);
	});
	const elapsedMs = $derived(Math.max(0, now - oldestStart));
	const showElapsed = $derived(hasRunning && elapsedMs >= ELAPSED_VISIBLE_MS);
	const lastActivityAt = $derived(chat.toolUpdatedAt ?? chat.streamStartedAt ?? oldestStart);
	const quietMs = $derived(Math.max(0, now - lastActivityAt));
	const canUsePartial = $derived(chat.hasAssistantOutput);
	const showRecovery = $derived(
		hasRunning &&
			runState !== 'cancel_requested' &&
			elapsedMs >= RECOVERY_AFTER_MS &&
			quietMs >= RECOVERY_QUIET_MS &&
			!recoveryDismissed
	);

	const liveText = $derived(dominantLiveLabel(liveNames));
	const visible = $derived(hasRunning || completed.length > 0 || (activeTurn && chat.streaming));

	const headLabel = $derived.by(() => {
		if (runState === 'cancel_requested') return 'Stopping';
		if (runState === 'reconnecting') return 'Reconnecting';
		if (hasRunning) return liveText || 'Searching';
		if (activeTurn && chat.streaming) return 'Writing answer';
		return '';
	});

	function answerWithWhatWeHave() {
		recoveryDismissed = true;
		chat.cancel('partial');
	}

	function stop() {
		recoveryDismissed = true;
		chat.cancel();
	}

</script>

{#if visible}
	<div class="tool-activity" class:tool-activity--idle={!hasRunning} role="status" aria-live="polite">
		{#if hasRunning || (activeTurn && chat.streaming)}
		<div class="tool-activity__head">
			<span class="pulse__dots tool-activity__dots" aria-hidden="true"
				><span></span><span></span><span></span></span
			>
			<span class="tool-activity__label">{headLabel}</span>
			{#if runningTools.length > 1}
				<span class="tool-activity__count">· {runningTools.length} actions</span>
			{/if}
			{#if showElapsed}
				<span class="tool-activity__elapsed">{formatElapsed(elapsedMs)}</span>
			{/if}
		</div>
		{/if}
		{#if runningTools.length}
			<ul class="tool-activity__actions" aria-label="Current actions">
				{#each runningTools.slice(0, 5) as tool (tool.id)}
					<li><span>{toolStepLabel(tool)}</span>{#if toolStepDetail(tool)}<span class="tool-activity__detail">{toolStepDetail(tool)}</span>{/if}</li>
				{/each}
			</ul>
		{/if}
		{#if completed.length}
			<details class="tool-activity__results">
				<summary>{completed.length} action{completed.length === 1 ? '' : 's'} completed</summary>
				<ul class="tool-activity__actions" aria-label="Action results">
					{#each completed as tool (tool.id)}
						<li>
							<span>{tool.status === 'failed' ? 'This action could not be completed.' : toolStepLabel(tool, true)}</span>
							{#if toolStepDetail(tool)}<span class="tool-activity__detail">{toolStepDetail(tool)}</span>{/if}
							{#if toolStepResult(tool) && toolStepResult(tool) !== toolStepDetail(tool)}<span class="tool-activity__result">{toolStepResult(tool)}</span>{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}

		{#if showRecovery}
			<div class="tool-activity__recovery" role="status">
				<span class="tool-activity__recovery__msg">
					This step is taking a while.
				</span>
				<div class="tool-activity__recovery__actions">
					{#if canUsePartial}
						<button
						type="button"
						class="tool-activity__btn tool-activity__btn--primary"
						onclick={answerWithWhatWeHave}
					>
							Use current answer
						</button>
					{/if}
					<button type="button" class="tool-activity__btn" onclick={stop}>Stop</button>
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.tool-activity {
		margin-top: 6px;
		margin-bottom: 4px;
		font-family: var(--font-body);
		font-size: 12px;
		color: var(--fg-2);
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
	}

	.tool-activity__results { margin-top: 4px; color: var(--fg-3); }
	.tool-activity__results summary { cursor: pointer; }
	.tool-activity__actions { list-style: none; margin: 4px 0; padding: 0; }
	.tool-activity__actions li { display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 3px 0; }
	.tool-activity__detail { color: var(--fg-3); overflow-wrap: anywhere; }
	.tool-activity__result { flex-basis: 100%; color: var(--fg-2); overflow-wrap: anywhere; }

	.tool-activity__head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 4px 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		text-transform: inherit;
		letter-spacing: inherit;
		cursor: default;
		text-align: left;
	}

	.tool-activity__label {
		color: var(--fg-2);
		font-weight: 500;
		flex: 0 0 auto;
	}

	.tool-activity__count,
	.tool-activity__elapsed {
		color: var(--fg-3);
		font-weight: 500;
	}

	.tool-activity__elapsed {
		margin-left: auto;
	}

	.tool-activity__dots {
		min-width: 18px;
	}

	.tool-activity__recovery {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 12px;
		align-items: center;
		justify-content: space-between;
		padding: 8px 0 2px;
		color: var(--fg-2);
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
		letter-spacing: 0;
		padding: 2px 8px;
		background: transparent;
		border: 1px solid var(--border-default);
		color: var(--fg-2);
		border-radius: var(--radius-1);
		cursor: pointer;
		transition:
			background var(--dur-fast) var(--ease-std),
			color var(--dur-fast) var(--ease-std),
			border-color var(--dur-fast) var(--ease-std);
	}

	.tool-activity__btn:hover {
		border-color: var(--border-strong);
		background: var(--bg-surface);
	}

	.tool-activity__btn:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.tool-activity__btn--primary {
		background: var(--cobalt-500);
		color: var(--ink-0);
		border-color: var(--cobalt-500);
	}

	.tool-activity__btn--primary:hover {
		background: var(--cobalt-700);
		border-color: var(--cobalt-700);
		color: var(--ink-0);
	}
</style>
