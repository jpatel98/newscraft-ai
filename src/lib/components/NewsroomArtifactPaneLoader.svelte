<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ArtifactDraft } from './artifact-draft';
	import type { AnswerUseAction } from './journalist-ui';
	import { validatedSourceUrl } from '$lib/utils/artifact-presentation';

	interface Props { draft: ArtifactDraft; disabled?: boolean; onSelect: (action: AnswerUseAction, sourceMessageId: string) => Promise<void> | void; onClose: () => void; }
	type Pane = typeof import('./NewsroomArtifactPane.svelte')['default'];
	let { draft, disabled = false, onSelect, onClose }: Props = $props();
	let Component = $state<Pane | null>(null);
	let failed = $state(false);
	let disposed = false;
	const sources = $derived(draft.citations.map((citation) => ({ ...citation, href: validatedSourceUrl(citation.url) })).filter((citation) => citation.href));
	onMount(() => {
		void import('./NewsroomArtifactPane.svelte').then(({ default: component }) => { if (!disposed) Component = component; }).catch(() => { if (!disposed) failed = true; });
	});
	onDestroy(() => { disposed = true; });
</script>

{#if Component}
	<Component {draft} {disabled} {onSelect} {onClose} />
{:else}
	<aside class="loader-pane" data-testid="newsroom-artifact-pane" aria-label="Newsroom artifact">
		<header><div><small>Newsroom artifact</small><h2>Preparing newsroom copy</h2></div><button type="button" aria-label="Close artifact pane" onclick={onClose}>×</button></header>
		{#if failed}<p role="alert"><strong>Interactive editor unavailable.</strong> The readable view remains available below.</p>{:else}<p role="status">Preparing interactive editor. Readable copy remains available.</p>{/if}
		<pre>{draft.content || 'Drafting newsroom copy…'}</pre>
		{#if sources.length}<h3>Sources</h3><ul>{#each sources as source}<li><a href={source.href} target="_blank" rel="noreferrer">{source.title}</a></li>{/each}</ul>{/if}
	</aside>
{/if}

<style>
	.loader-pane { width:min(430px,40vw); min-width:340px; overflow:auto; padding:18px; border-left:1px solid var(--border-default); background:var(--bg-surface); color:var(--fg-1); }
	header { display:flex; justify-content:space-between; gap:12px; } pre { white-space:pre-wrap; font:inherit; line-height:1.55; } a { color:var(--accent-fg); }
	@media (max-width:860px) { .loader-pane { position:fixed; inset:48px 0 0; z-index:60; width:100%; min-width:0; border:0; border-top:1px solid var(--border-default); } }
</style>
