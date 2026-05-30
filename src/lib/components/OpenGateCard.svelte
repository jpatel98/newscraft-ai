<script lang="ts">
	import type { EditorialGate, EditorialGateType } from '$lib/types';
	import {
		draftReviewPayloadFromValue,
		segmentDraftWithCitations,
		type CitationRecord
	} from '$lib/utils/citations';

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
	let selectedCitationMarker = $state<number | null>(null);

	const typeLabels: Record<EditorialGateType, string> = {
		pitch: 'Pitch',
		verification: 'Verification',
		draft_review: 'Draft Review',
		legal_style: 'Legal / Style',
		publish: 'Publish',
		crawl_plan: 'Source Review',
		source_health: 'Source Health',
		budget: 'Budget'
	};

	const draftReview = $derived(gate.type === 'draft_review' ? draftReviewPayloadFromValue(gate.payload) : null);
	const draftSegments = $derived(
		draftReview ? segmentDraftWithCitations(draftReview.markdown, draftReview.citations) : []
	);
	const selectedCitation = $derived(citationForMarker(draftReview?.citations ?? [], selectedCitationMarker));

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

	function citationForMarker(citations: CitationRecord[], marker: number | null): CitationRecord | null {
		if (marker !== null) {
			const match = citations.find((citation) => citation.marker === marker);
			if (match) return match;
		}
		return citations[0] ?? null;
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

	{#if draftReview}
		<section class="open-gate-card__draft" aria-label="Draft review citation preview">
			<div class="open-gate-card__draft-head">
				<strong>{draftReview.headline || 'Draft for review'}</strong>
				{#if draftReview.wordCount}
					<span>{draftReview.wordCount} words</span>
				{/if}
			</div>
			<p class="open-gate-card__draft-text">
				{#each draftSegments as segment, index (segment.kind === 'citation' ? `citation-${segment.marker}-${index}` : `text-${index}`)}
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
			{#if selectedCitation}
				<aside class="open-gate-card__citation" aria-label={`Citation ${selectedCitation.marker} source details`}>
					<div>
						<span>Citation [{selectedCitation.marker}]</span>
						<strong>{selectedCitation.sourceTitle}</strong>
					</div>
					<p>{selectedCitation.claim}</p>
					<div class="open-gate-card__citation-links">
						<a href={selectedCitation.sourceUrl} target="_blank" rel="noreferrer">Original source</a>
						<a href={selectedCitation.archiveUrl} target="_blank" rel="noreferrer">Archive fallback</a>
					</div>
					{#if selectedCitation.contentHash}
						<small>Hash {selectedCitation.contentHash}</small>
					{/if}
				</aside>
			{/if}
		</section>
	{/if}

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

	.open-gate-card__draft {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
		border: 1px solid var(--border-soft);
		background: var(--bg-raised);
	}

	.open-gate-card__draft-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.open-gate-card__draft-head strong {
		color: var(--fg-1);
		font-family: var(--font-display);
		font-size: var(--fs-h4);
		line-height: var(--lh-h4);
	}

	.open-gate-card__draft-head span,
	.open-gate-card__citation span,
	.open-gate-card__citation small {
		color: var(--fg-3);
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		font-weight: var(--fw-medium);
		text-transform: uppercase;
	}

	.open-gate-card__draft-text {
		white-space: pre-wrap;
	}

	.open-gate-card__draft-text button {
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

	.open-gate-card__draft-text button:hover,
	.open-gate-card__draft-text button.active {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--fg-1);
	}

	.open-gate-card__citation {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--border-default);
		border-left: 3px solid var(--accent);
		background: var(--bg-surface);
	}

	.open-gate-card__citation strong {
		display: block;
		margin-top: var(--space-1);
		color: var(--fg-1);
	}

	.open-gate-card__citation-links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.open-gate-card__citation-links a {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-1);
		color: var(--accent-fg);
		font-size: var(--fs-body-sm);
		font-weight: var(--fw-semibold);
		padding: 0.35rem 0.5rem;
		text-decoration: none;
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
