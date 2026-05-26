<script lang="ts">
	import type { EditorialGate, EditorialGateType } from '$lib/types';

	let {
		gate,
		busy = false,
		onResolve
	}: {
		gate: EditorialGate;
		busy?: boolean;
		onResolve: (gate: EditorialGate, action: string, notes: string) => void | Promise<void>;
	} = $props();

	let notes = $state('');

	const typeLabels: Record<EditorialGateType, string> = {
		pitch: 'Pitch',
		verification: 'Verification',
		draft_review: 'Draft Review',
		legal_style: 'Legal / Style',
		publish: 'Publish',
		crawl_plan: 'Crawl Plan',
		source_health: 'Source Health',
		budget: 'Budget'
	};

	async function resolve(action: string) {
		await onResolve(gate, action, notes.trim());
		notes = '';
	}

	function actionLabel(action: string): string {
		return action
			.split('_')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}
</script>

<article class="open-gate-card" aria-label={typeLabels[gate.type] + ' open gate'}>
	<div class="open-gate-card__head">
		<div>
			<div class="open-gate-card__eyebrow">Open Gate</div>
			<h3>{gate.title}</h3>
		</div>
		<div class="open-gate-card__meta">
			<span>{typeLabels[gate.type]}</span>
			<span>P{gate.priority}</span>
		</div>
	</div>

	<p>{gate.summary}</p>

	<label class="open-gate-card__notes">
		<span>Notes</span>
		<textarea bind:value={notes} rows="3" disabled={busy} placeholder="Add editor notes..."></textarea>
	</label>

	<div class="open-gate-card__actions">
		{#each gate.actions as action}
			<button type="button" disabled={busy} onclick={() => resolve(action)}>
				{actionLabel(action)}
			</button>
		{/each}
	</div>
</article>

<style>
	.open-gate-card {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border-default);
		border-top: 2px solid var(--accent);
		border-radius: var(--radius-2);
		background: var(--bg-surface);
	}

	.open-gate-card__head {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		align-items: start;
	}

	.open-gate-card__eyebrow,
	.open-gate-card__meta,
	.open-gate-card__notes span {
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		letter-spacing: var(--tr-meta);
		text-transform: uppercase;
	}

	.open-gate-card h3 {
		margin: var(--space-1) 0 0;
		color: var(--fg-1);
		font-family: var(--font-display);
		font-size: var(--fs-h4);
		line-height: var(--lh-h4);
		letter-spacing: 0;
	}

	.open-gate-card p {
		margin: 0;
		color: var(--fg-2);
		line-height: var(--lh-body);
	}

	.open-gate-card__meta {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}

	.open-gate-card__meta span {
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-2);
		background: var(--bg-raised);
		padding: 3px 7px;
		white-space: nowrap;
	}

	.open-gate-card__notes {
		display: grid;
		gap: var(--space-2);
	}

	.open-gate-card__notes textarea {
		width: 100%;
		min-width: 0;
		resize: vertical;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--bg-raised);
		color: var(--fg-1);
		font: inherit;
		line-height: var(--lh-body);
		padding: var(--space-3);
	}

	.open-gate-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.open-gate-card__actions button {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-2);
		background: var(--accent);
		color: var(--fg-on-accent);
		cursor: pointer;
		font: inherit;
		font-size: var(--fs-body-sm);
		font-weight: var(--fw-semibold);
		padding: 7px 10px;
	}

	.open-gate-card__actions button:hover:not(:disabled) {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
	}

	.open-gate-card__actions button:disabled,
	.open-gate-card__notes textarea:disabled {
		cursor: wait;
		opacity: 0.7;
	}

	@media (max-width: 680px) {
		.open-gate-card__head {
			display: grid;
		}

		.open-gate-card__meta {
			justify-content: flex-start;
		}
	}
</style>
