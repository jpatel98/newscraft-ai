<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import type { ArtifactDetail } from '$lib/types/artifacts';
	import { validatedSourceUrl } from '$lib/utils/artifact-presentation';
	import { activeHTMLElement, focusDialog, restoreFocus, trapTabKey } from '$lib/utils/focus';

	interface Props {
		artifact: ArtifactDetail;
		conversationId: string;
		onClose: () => void;
		onRetry?: () => void;
	}
	type Canvas = typeof import('./ArtifactCanvas.svelte')['default'];
	let { artifact, conversationId, onClose, onRetry }: Props = $props();
	let Component = $state<Canvas | null>(null);
	let shell = $state<HTMLDivElement | null>(null);
	let failed = $state(false);
	let opener: HTMLElement | null = null;
	let disposed = false;

	const sources = $derived((artifact.spec.sources ?? []).map((source) => ({
		...source, href: validatedSourceUrl(source.url)
	})));
	const asset = $derived(artifact.assets.find((item) => item.role === 'preview') ?? artifact.assets.find((item) => item.role === 'source'));
	const assetUrl = $derived(asset ? `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(artifact.id)}/revisions/${encodeURIComponent(artifact.revisionId)}/assets/${encodeURIComponent(asset.id)}` : null);

	onMount(() => {
		opener = activeHTMLElement();
		void import('./ArtifactCanvas.svelte').then(({ default: component }) => {
			if (!disposed) Component = component;
		}).catch(() => { if (!disposed) failed = true; });
		void tick().then(() => { if (!disposed && !Component) focusDialog(shell); });
	});
	onDestroy(() => { disposed = true; restoreFocus(opener); });

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
			return;
		}
		trapTabKey(event, shell);
	}
</script>

{#if Component}
	<Component {artifact} {conversationId} {onClose} {onRetry} />
{:else}
	<div class="loader-backdrop" role="presentation">
		<div bind:this={shell} class="loader-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-loader-title" tabindex="-1" onkeydown={keydown}>
			<header>
				<div><small>Newsroom canvas</small><h2 id="artifact-loader-title">{artifact.title}</h2></div>
				<button class="close" type="button" aria-label="Close canvas" onclick={onClose}>×</button>
			</header>
			{#if failed}
				<p role="alert">The interactive view could not load. Available content is shown below.</p>
			{:else}
				<p role="status">Loading interactive view…</p>
			{/if}
			{#if artifact.status === 'publishing' || artifact.status === 'draft'}
				<p role="status">Preparing this artifact. The written answer remains available.</p>
			{:else if artifact.status === 'failed' || artifact.status === 'cancelled' || artifact.status === 'missing'}
				<p role="alert">{artifact.error?.message ?? 'Artifact data is unavailable. The written answer remains available.'}</p>
				{#if onRetry}<button type="button" onclick={onRetry}>Try loading artifact data again</button>{/if}
			{:else if artifact.spec.kind === 'markdown'}
				<pre>{artifact.spec.markdown}</pre>
			{:else if artifact.spec.kind === 'image'}
				{#if assetUrl}<img src={assetUrl} alt={artifact.spec.alt} />{/if}
				<p>{artifact.spec.caption ?? artifact.spec.alt}</p>
			{:else if artifact.spec.kind === 'chart'}
				<table>
					<caption>{artifact.spec.title}</caption>
					<thead><tr><th scope="col">Period</th><th scope="col">Series</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Status</th></tr></thead>
					<tbody>{#each artifact.spec.series as series}{#each series.points as point}
						<tr><td>{point.period}</td><td>{series.label}</td><td>{point.value ?? '—'}</td><td>{series.unit ?? artifact.spec.unit ?? '—'}</td><td>{point.status ?? (point.value === null ? 'missing' : 'observed')}</td></tr>
					{/each}{/each}</tbody>
				</table>
			{:else if artifact.spec.kind === 'table'}
				<table>
					<caption>{artifact.spec.title}</caption>
					<thead><tr>{#each artifact.spec.columns as column}<th scope="col">{column.label}</th>{/each}</tr></thead>
					<tbody>{#each artifact.spec.rows as row}<tr>{#each artifact.spec.columns as column}<td>{row[column.id] ?? '—'}</td>{/each}</tr>{/each}</tbody>
				</table>
			{:else if artifact.spec.kind === 'map'}
				<table>
					<caption>{artifact.spec.title}</caption>
					<thead><tr><th scope="col">Place</th><th scope="col">Geometry</th><th scope="col">Coordinates (longitude, latitude)</th></tr></thead>
					<tbody>{#each artifact.spec.features as feature, index}<tr><td>{feature.properties?.label ?? `Place ${index + 1}`}</td><td>{feature.geometry.type}</td><td>{JSON.stringify(feature.geometry.coordinates)}</td></tr>{/each}</tbody>
				</table>
			{/if}
			{#if sources.length}
				<h3>Sources</h3>
				<ul>{#each sources as source}<li>{#if source.href}<a href={source.href} target="_blank" rel="noreferrer">{source.label}</a>{:else}{source.label}{/if}</li>{/each}</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.loader-backdrop { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; padding: 20px; background: rgb(15 23 42 / 28%); }
	.loader-dialog { box-sizing: border-box; min-width: 0; width: min(980px, 100%); max-height: calc(100dvh - 40px); overflow: auto; padding: 20px; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface); color: var(--fg-1); }
	header { display: flex; justify-content: space-between; gap: 12px; }
	h2 { margin: 4px 0 12px; overflow-wrap: anywhere; }
	p { margin-block: 12px; }
	pre { white-space: pre-wrap; overflow-wrap: anywhere; }
	table { width: 100%; border-collapse: collapse; text-align: left; }
	th, td { padding: 6px; border-bottom: 1px solid var(--border-soft); }
	img { max-width: 100%; height: auto; }
	button { padding: 8px 12px; border: 1px solid var(--border-default); border-radius: 6px; }
	.close { flex: 0 0 36px; height: 36px; padding: 0; font-size: 24px; }
	button:focus-visible, a:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
	@media (max-width: 700px) { .loader-backdrop { padding: 0; } .loader-dialog { width: 100%; max-height: 100dvh; border-radius: 0; } }
</style>
