<script lang="ts">
	import { outletLabel, shortSourceDateLabel } from '$lib/utils/source-labels';
	import type { AnswerSource } from '$lib/utils/tool-metadata';

	interface Props {
		/** Distinct sources the answer used, already sorted newest first. */
		sources: AnswerSource[];
	}

	const COLLAPSED_LIMIT = 6;

	let { sources }: Props = $props();
	let expanded = $state(false);

	const visible = $derived(expanded ? sources : sources.slice(0, COLLAPSED_LIMIT));
	const hiddenCount = $derived(sources.length - visible.length);

	function sourceName(source: AnswerSource): string {
		// Web sources read best as the outlet; documents and notes as their own label.
		return source.domain.includes('.') ? outletLabel(source.domain) : source.label;
	}
</script>

{#if sources.length > 0}
	<div class="source-row" data-testid="message-sources">
		<span class="source-row__label">Sources</span>
		<ul class="source-row__list">
			{#each visible as source (source.url)}
				<li class="source-row__item">
					<a
						class="source-row__link"
						href={source.url}
						target="_blank"
						rel="noopener noreferrer"
						title={source.label}
					>
						{sourceName(source)}
					</a>
					<span class="source-row__date">{shortSourceDateLabel(source.publicationDate)}</span>
					{#if source.archivedUrl}
						<a
							class="source-row__archive-link"
							href={source.archivedUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							archive copy
						</a>
					{/if}
				</li>
			{/each}
			{#if hiddenCount > 0}
				<li>
					<button type="button" class="source-row__more" onclick={() => (expanded = true)}>
						+{hiddenCount} more
					</button>
				</li>
			{/if}
		</ul>
	</div>
{/if}

<style>
	.source-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-top: 8px;
		max-width: 100%;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-2);
	}

	.source-row__label {
		flex: none;
		color: var(--fg-3);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.source-row__list {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.source-row__item {
		display: inline-flex;
		min-width: 0;
		max-width: 100%;
		align-items: baseline;
		gap: 6px;
	}

	.source-row__link {
		min-width: 0;
		color: var(--cobalt-700);
		text-decoration: underline;
		text-underline-offset: 2px;
		overflow-wrap: anywhere;
	}

	.source-row__date {
		flex: none;
		color: var(--fg-3);
	}

	.source-row__archive-link {
		color: var(--fg-3);
		font-size: 10px;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.source-row__more {
		padding: 0;
		border: 0;
		background: none;
		color: var(--fg-2);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.source-row__more:hover {
		color: var(--fg-1);
	}

	.source-row__more:focus-visible,
	.source-row__link:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}
</style>
