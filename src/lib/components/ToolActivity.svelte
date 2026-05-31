<script lang="ts">
	import { chat } from '$lib/stores/chat.svelte';
	import { dominantLiveLabel, formatElapsed } from '$lib/utils/tool-labels';

	interface Props {
		// True when this card is attached to the current assistant turn.
		activeTurn: boolean;
	}
	let { activeTurn }: Props = $props();

	const ELAPSED_VISIBLE_MS = 5_000;
	const RECOVERY_AFTER_MS = 45_000;
	const RECOVERY_QUIET_MS = 15_000;

	let now = $state(Date.now());
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
	const liveNames = $derived(chat.tools.map((t) => t.name));

	const oldestStart = $derived.by(() => {
		if (chat.tools.length === 0) return chat.streamStartedAt ?? Date.now();
		return chat.tools.reduce(
			(min, t) => (t.startedAt < min ? t.startedAt : min),
			chat.tools[0].startedAt
		);
	});
	const elapsedMs = $derived(Math.max(0, now - oldestStart));
	const showElapsed = $derived(hasRunning && elapsedMs >= ELAPSED_VISIBLE_MS);
	const lastActivityAt = $derived(chat.toolUpdatedAt ?? chat.streamStartedAt ?? oldestStart);
	const quietMs = $derived(Math.max(0, now - lastActivityAt));
	const canUsePartial = $derived(chat.hasAssistantOutput);
	const showRecovery = $derived(
		hasRunning &&
			elapsedMs >= RECOVERY_AFTER_MS &&
			quietMs >= RECOVERY_QUIET_MS &&
			!recoveryDismissed
	);

	const liveText = $derived(dominantLiveLabel(liveNames));
	const visible = $derived(hasRunning || (activeTurn && chat.streaming));

	const headLabel = $derived.by(() => {
		if (hasRunning) return liveText || 'Searching';
		if (activeTurn && chat.streaming) return 'Drafting answer';
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
		<div class="tool-activity__head">
			<span class="pulse__dots tool-activity__dots" aria-hidden="true"
				><span></span><span></span><span></span></span
			>
			<span class="tool-activity__label">{headLabel}</span>
			{#if chat.tools.length > 1}
				<span class="tool-activity__count">· searching multiple sources</span>
			{/if}
			{#if showElapsed}
				<span class="tool-activity__elapsed">{formatElapsed(elapsedMs)}</span>
			{/if}
		</div>

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
		letter-spacing: 0;
		max-width: 100%;
		min-width: 0;
		overflow: hidden;
	}

	.tool-activity--idle {
		border-left-color: var(--signal-500);
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
		cursor: default;
		text-align: left;
	}

	.tool-activity__label {
		color: var(--fg-1);
		font-weight: 600;
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
		padding: 6px 10px 8px;
		border-top: 1px solid var(--border-soft);
		background: var(--bg-raised);
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
