<script lang="ts">
	import { untrack } from 'svelte';
	import { chat } from '$lib/stores/chat.svelte';
	import { publicPlanStepDetail } from '$lib/utils/tool-labels';

	interface Props {
		/** True when attached to the current in-flight assistant turn. */
		activeTurn: boolean;
	}
	let { activeTurn }: Props = $props();

	// Once the answer starts streaming, collapse the timeline to a one-line
	// summary. The user can expand it afterward.
	let expanded = $state(true);

	// Re-expand whenever a brand-new plan arrives (new stream started).
	$effect(() => {
		if (chat.plan) {
			expanded = true;
		}
	});

	// Collapse as soon as the first answer token arrives.
	// Use untrack() to read `expanded` without making it a reactive dependency —
	// this ensures the effect only fires when hasAssistantOutput changes (not on
	// every expand/collapse toggle), so the user can manually re-expand afterward.
	$effect(() => {
		if (chat.hasAssistantOutput) {
			if (untrack(() => expanded)) expanded = false;
		}
	});

	const plan = $derived(chat.plan);
	const visible = $derived(!!plan && plan.steps.length > 0);

	// For the collapsed one-line summary: pick the running step label, or the
	// last completed/failed label if all are done.
	const summaryLabel = $derived.by(() => {
		if (!plan) return '';
		const running = plan.steps.find((s) => s.status === 'running');
		if (running) return running.label;
		const all = plan.steps;
		const failed = all.filter((s) => s.status === 'failed');
		if (failed.length) return `${failed.length} step${failed.length > 1 ? 's' : ''} failed`;
		const done = all.filter((s) => s.status === 'ok' || s.status === 'skipped');
		if (done.length === all.length) return `${all.length} step${all.length > 1 ? 's' : ''} complete`;
		return all[0]?.label ?? 'Researching';
	});

	const totalSteps = $derived(plan?.steps.length ?? 0);
	const doneCount = $derived(plan?.steps.filter((s) => s.status === 'ok' || s.status === 'skipped').length ?? 0);
	const hasFailures = $derived((plan?.steps.filter((s) => s.status === 'failed').length ?? 0) > 0);

	function toggle() {
		expanded = !expanded;
	}
</script>

{#if visible && plan}
	<div
		class="plan-timeline"
		class:plan-timeline--collapsed={!expanded}
		class:plan-timeline--has-failures={hasFailures}
		data-testid="plan-timeline"
		role="status"
		aria-live="polite"
		aria-label="Research plan"
	>
		<!-- Header: always visible; clicking collapses/expands -->
		<button
			type="button"
			class="plan-timeline__head"
			onclick={toggle}
			aria-expanded={expanded}
			aria-label={expanded ? 'Collapse research plan' : 'Expand research plan'}
		>
			{#if !expanded || !activeTurn || chat.hasAssistantOutput}
				<!-- Collapsed summary -->
				<span class="plan-timeline__chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
				<span class="plan-timeline__summary-label">{summaryLabel}</span>
				{#if !activeTurn || !chat.streaming}
					<span class="plan-timeline__summary-count">{doneCount}/{totalSteps}</span>
				{/if}
			{:else}
				<!-- Expanded live header while still running -->
				<span class="pulse__dots plan-timeline__dots" aria-hidden="true"
					><span></span><span></span><span></span></span
				>
				<span class="plan-timeline__head-label">Research plan</span>
				<span class="plan-timeline__chevron plan-timeline__chevron--right" aria-hidden="true">▾</span>
			{/if}
		</button>

		{#if expanded}
			<ol class="plan-timeline__steps" aria-label="Research steps">
				{#each plan.steps as step (step.id)}
					<li
						class="plan-timeline__step plan-timeline__step--{step.status}"
						data-testid="plan-step"
						data-step-status={step.status}
					>
						<span
							class="plan-timeline__step-icon"
							aria-hidden="true"
						>
							{#if step.status === 'pending'}
								<span class="plan-timeline__step-dot"></span>
							{:else if step.status === 'running'}
								<span class="plan-timeline__step-spin" aria-hidden="true"></span>
							{:else if step.status === 'ok'}
								<span class="plan-timeline__step-check">✓</span>
							{:else if step.status === 'failed'}
								<span class="plan-timeline__step-fail">✕</span>
							{:else if step.status === 'skipped'}
								<span class="plan-timeline__step-skip">–</span>
							{/if}
						</span>
						<span class="plan-timeline__step-body">
							<span class="plan-timeline__step-label">{step.label}</span>
							{#if publicPlanStepDetail(step.detail) && (step.status === 'failed' || step.status === 'skipped')}
								<span class="plan-timeline__step-detail">{publicPlanStepDetail(step.detail)}</span>
							{/if}
							{#if step.sources && step.sources.length > 0}
								<ul class="plan-timeline__step-sources" aria-label="Sources found">
									{#each step.sources as src (src.url)}
										<li class="plan-timeline__step-source">
											<a
												class="plan-timeline__step-source-link"
												href={src.url}
												target="_blank"
												rel="noopener noreferrer"
												title={src.title}
											>{src.title}</a>
										</li>
									{/each}
								</ul>
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
{/if}

<style>
	.plan-timeline {
		margin-top: 6px;
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

	.plan-timeline--has-failures {
		border-left-color: var(--danger-fg, #b34040);
	}

	/* collapsed: tighten the border when answer is streaming */
	.plan-timeline--collapsed {
		border-left-color: var(--signal-500);
	}

	/* --- head button --- */
	.plan-timeline__head {
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

	.plan-timeline__head:hover {
		background: var(--bg-raised);
	}

	.plan-timeline__head:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.plan-timeline__dots {
		min-width: 18px;
	}

	.plan-timeline__head-label {
		color: var(--fg-1);
		font-weight: 600;
		flex: 1 1 auto;
	}

	.plan-timeline__summary-label {
		color: var(--fg-1);
		font-weight: 600;
		flex: 1 1 auto;
	}

	.plan-timeline__summary-count {
		color: var(--fg-3);
		font-weight: 500;
		font-size: 10px;
	}

	.plan-timeline__chevron {
		color: var(--fg-3);
		font-size: 10px;
		font-style: normal;
		min-width: 10px;
	}

	.plan-timeline__chevron--right {
		margin-left: auto;
	}

	/* --- step list --- */
	.plan-timeline__steps {
		list-style: none;
		margin: 0;
		padding: 0 0 4px;
		border-top: 1px solid var(--border-soft);
	}

	.plan-timeline__step {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 5px 10px 5px 10px;
		min-height: 28px;
	}

	.plan-timeline__step + .plan-timeline__step {
		border-top: 1px solid var(--border-soft);
	}

	/* --- step status icons --- */
	.plan-timeline__step-icon {
		flex: 0 0 14px;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-top: 1px;
		font-size: 10px;
		font-style: normal;
		min-height: 14px;
	}

	.plan-timeline__step-dot {
		display: block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--border-strong, #bbb);
	}

	.plan-timeline__step-spin {
		display: block;
		width: 10px;
		height: 10px;
		border: 2px solid var(--cobalt-200);
		border-top-color: var(--cobalt-500);
		border-radius: 50%;
		animation: plan-spin 0.75s linear infinite;
	}

	@keyframes plan-spin {
		to { transform: rotate(360deg); }
	}

	.plan-timeline__step-check {
		color: var(--signal-500);
		font-size: 11px;
		line-height: 1;
	}

	.plan-timeline__step-fail {
		color: var(--danger-fg, #b34040);
		font-size: 11px;
		line-height: 1;
	}

	.plan-timeline__step-skip {
		color: var(--fg-4, var(--fg-3));
		font-size: 13px;
		line-height: 1;
	}

	/* --- step body --- */
	.plan-timeline__step-body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1 1 auto;
		min-width: 0;
	}

	.plan-timeline__step-label {
		color: var(--fg-1);
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.plan-timeline__step--pending .plan-timeline__step-label {
		color: var(--fg-3);
		font-weight: 400;
	}

	.plan-timeline__step--failed .plan-timeline__step-label {
		color: var(--danger-fg, #b34040);
	}

	.plan-timeline__step--skipped .plan-timeline__step-label {
		color: var(--fg-3);
		font-weight: 400;
	}

	.plan-timeline__step-detail {
		font-size: 10px;
		color: var(--fg-3);
		text-transform: none;
		letter-spacing: 0;
		font-family: var(--font-body);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* --- per-step sources --- */
	.plan-timeline__step-sources {
		list-style: none;
		margin: 3px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.plan-timeline__step-source {
		display: flex;
		min-width: 0;
	}

	.plan-timeline__step-source-link {
		font-size: 10px;
		font-family: var(--font-body);
		text-transform: none;
		letter-spacing: 0;
		color: var(--cobalt-600, var(--cobalt-500));
		text-decoration: none;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.plan-timeline__step-source-link:hover {
		text-decoration: underline;
		color: var(--cobalt-700, var(--cobalt-500));
	}

	@media (max-width: 620px) {
		.plan-timeline {
			font-size: 11px;
		}
		.plan-timeline__step {
			gap: 7px;
			padding: 7px 10px 7px 10px;
		}
		.plan-timeline__head {
			gap: 7px;
		}
		.plan-timeline__summary-label,
		.plan-timeline__head-label {
			font-size: 11px;
		}
		.plan-timeline__summary-count {
			font-size: 10px;
		}
		.plan-timeline__step-label {
			white-space: normal;
			line-height: 1.35;
		}
		.plan-timeline__step-detail,
		.plan-timeline__step-source-link {
			font-size: 10px;
		}
	}
</style>
