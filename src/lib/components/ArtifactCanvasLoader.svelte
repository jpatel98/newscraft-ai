<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import type { ArtifactDetail } from '$lib/types/artifacts';
	import { activeHTMLElement, focusDialog, restoreFocus, trapTabKey } from '$lib/utils/focus';

	interface Props { artifact: ArtifactDetail; conversationId: string; onClose: () => void; onRetry?: () => void; }
	type Canvas = typeof import('./ArtifactCanvas.svelte')['default'];
	let { artifact, conversationId, onClose, onRetry: _onRetry }: Props = $props();
	let Component = $state<Canvas | null>(null);
	let shell = $state<HTMLDivElement | null>(null);
	let opener: HTMLElement | null = null;
	let disposed = false;
	let failed = $state(false);
	onMount(() => {
		opener = activeHTMLElement();
		void import('./ArtifactCanvas.svelte').then(({ default: component }) => {
			if (!disposed) Component = component;
		}).catch(() => { if (!disposed) failed = true; });
		void tick().then(() => { if (!disposed && !Component) focusDialog(shell); });
	});
	onDestroy(() => { disposed = true; restoreFocus(opener); });
	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
		trapTabKey(event, shell);
	}
	function readableRows() {
		const spec = artifact.spec;
		if (spec.kind === 'table') return spec.rows.map((row) => spec.columns.map((column) => row[column.id] ?? '—'));
		if (spec.kind === 'chart') return spec.series.flatMap((series) => series.points.map((point) => [point.period, series.label, point.value ?? '—', point.status ?? (point.value === null ? 'missing' : 'observed')]));
		return spec.kind === 'map' ? spec.features.map((feature, index) => [feature.properties?.label ?? 'Marker ' + (index + 1), JSON.stringify(feature.geometry.coordinates)]) : [];
	}
	function readableHeaders() {
		if (artifact.spec.kind === 'table') return artifact.spec.columns.map((column) => column.label);
		if (artifact.spec.kind === 'chart') return ['Period', 'Series', 'Value', 'Status'];
		return ['Place', 'Coordinates'];
	}
	function assetUrl() {
		const asset = artifact.assets.find((candidate) => candidate.role === 'preview') ?? artifact.assets.find((candidate) => candidate.role === 'source');
		return asset ? '/api/conversations/' + encodeURIComponent(conversationId) + '/artifacts/' + encodeURIComponent(artifact.id) + '/revisions/' + encodeURIComponent(artifact.revisionId) + '/assets/' + encodeURIComponent(asset.id) : null;
	}
</script>

{#if Component}
	<Component {artifact} {conversationId} {onClose} onRetry={_onRetry} />
{:else}
	<div class="loader-backdrop" role="presentation">
		<div bind:this={shell} class="loader-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-loader-title" tabindex="-1" onkeydown={keydown}>
			<header><div><small>Newsroom canvas</small><h2 id="artifact-loader-title">{artifact.title}</h2></div><button type="button" aria-label="Close canvas" onclick={onClose}>×</button></header>
			{#if failed}<p role="alert"><strong>Interactive view unavailable.</strong> The readable view remains available below.</p>{:else}<p role="status">Preparing interactive view. The written answer remains available.</p>{/if}
			{#if artifact.spec.kind === 'markdown'}<pre>{artifact.spec.markdown}</pre>{:else if artifact.spec.kind === 'image'}{#if assetUrl()}<img src={assetUrl()} alt={artifact.spec.alt} />{/if}<p>{artifact.spec.caption ?? artifact.spec.alt}</p>{:else}<table><caption>{artifact.spec.title}</caption><thead><tr>{#each readableHeaders() as heading}<th>{heading}</th>{/each}</tr></thead><tbody>{#each readableRows() as row}<tr>{#each row as value}<td>{value}</td>{/each}</tr>{/each}</tbody></table>{/if}
		</div>
	</div>
{/if}
<style>
	.loader-backdrop { position:fixed; inset:0; z-index:60; display:grid; place-items:center; padding:20px; background:color-mix(in srgb,var(--ink-900) 28%,transparent); } .loader-dialog { width:min(860px,100%); max-height:86vh; overflow:auto; padding:20px; border:1px solid var(--border-default); border-radius:var(--radius-2); background:var(--bg-surface); color:var(--fg-1); } header { display:flex; justify-content:space-between; gap:12px; } h2 { margin:4px 0 12px; } pre { white-space:pre-wrap; } table { width:100%; border-collapse:collapse; } td { padding:6px; border-bottom:1px solid var(--border-soft); } img { max-width:100%; height:auto; } button:focus-visible { box-shadow:var(--shadow-focus); }
</style>
