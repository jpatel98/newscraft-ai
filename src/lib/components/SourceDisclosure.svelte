<script lang="ts">
	import type { DisplaySourceReceipt } from '$lib/utils/tool-metadata';

	interface Props {
		sources: DisplaySourceReceipt[];
		/** Structured inline citations are complete, so a second source list would be redundant. */
		resolvedInline?: boolean;
	}

	let { sources, resolvedInline = false }: Props = $props();
</script>

{#if sources.length > 0 && !resolvedInline}
	<details class="source-disclosure" data-testid="message-sources">
		<summary class="source-disclosure__summary">
			<span>Sources</span>
			<span class="source-disclosure__count">{sources.length}</span>
		</summary>
		<ul class="source-disclosure__list">
			{#each sources as source (source.url)}
				<li class="source-disclosure__item">
					<a class="source-disclosure__link" href={source.url} target="_blank" rel="noopener noreferrer">
						{source.label}
					</a>
					{#if source.domain && source.domain !== source.label}
						<span class="source-disclosure__domain">{source.domain}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.source-disclosure {
		margin-top: 8px;
		max-width: 100%;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--fg-2);
	}

	.source-disclosure__summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 24px;
		padding: 2px 8px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius-1);
		background: var(--bg-surface);
		color: var(--fg-2);
		cursor: pointer;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0;
	}

	.source-disclosure__summary:hover {
		border-color: var(--border-default);
		color: var(--fg-1);
	}

	.source-disclosure__summary:focus-visible {
		outline: none;
		box-shadow: var(--shadow-focus);
	}

	.source-disclosure__count {
		color: var(--fg-3);
		font-weight: 500;
	}

	.source-disclosure__list {
		display: grid;
		gap: 4px;
		margin: 6px 0 0;
		padding: 0;
		list-style: none;
	}

	.source-disclosure__item {
		display: flex;
		min-width: 0;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
	}

	.source-disclosure__link {
		min-width: 0;
		max-width: 100%;
		color: var(--cobalt-700);
		text-decoration: underline;
		text-underline-offset: 2px;
		overflow-wrap: anywhere;
	}

	.source-disclosure__domain {
		color: var(--fg-3);
		overflow-wrap: anywhere;
	}
</style>
