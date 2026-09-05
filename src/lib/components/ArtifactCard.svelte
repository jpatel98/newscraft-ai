<script lang="ts">
	import type { ArtifactSummary } from '$lib/types/artifacts';
	import BarChart3 from 'lucide-svelte/icons/bar-chart-3';
	import Image from 'lucide-svelte/icons/image';
	import Map from 'lucide-svelte/icons/map';
	import Table2 from 'lucide-svelte/icons/table-2';
	import FileText from 'lucide-svelte/icons/file-text';

	interface Props { artifact: ArtifactSummary; onOpen: (artifact: ArtifactSummary) => void; }
	let { artifact, onOpen }: Props = $props();
	const Icon = $derived(artifact.kind === 'chart' ? BarChart3 : artifact.kind === 'map' ? Map : artifact.kind === 'table' ? Table2 : artifact.kind === 'image' ? Image : FileText);
	const statusLabel = $derived(artifact.status === 'ready' ? 'Ready' : artifact.status === 'publishing' || artifact.status === 'draft' ? 'Preparing' : artifact.status === 'cancelled' ? 'Cancelled' : artifact.status === 'missing' ? 'Missing' : 'Unavailable');
</script>

<button class="artifact-card" type="button" data-testid="artifact-card" onclick={() => onOpen(artifact)} aria-label={`Open ${artifact.title}`}>
	<span class="artifact-card__icon" aria-hidden="true"><Icon size="16" strokeWidth={1.8} /></span>
	<span class="artifact-card__copy">
		<span class="artifact-card__title">{artifact.title}</span>
		<span class="artifact-card__meta">{artifact.kind} · {statusLabel}{artifact.fixture ? ' · synthetic fixture' : ''}</span>
	</span>
	<span class="artifact-card__chevron" aria-hidden="true">›</span>
</button>

<style>
	.artifact-card { width: min(560px, 100%); display: flex; align-items: center; gap: 10px; margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-2); background: var(--bg-surface); color: var(--fg-1); text-align: left; cursor: pointer; box-shadow: var(--shadow-1); }
	.artifact-card:hover { background: var(--bg-raised); border-color: var(--border-strong); }
	.artifact-card:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
	.artifact-card__icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; background: color-mix(in srgb, var(--cobalt-100) 65%, var(--bg-page)); color: var(--cobalt-700); }
	.artifact-card__copy { min-width: 0; display: grid; gap: 3px; }
	.artifact-card__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
	.artifact-card__meta { color: var(--fg-3); font: 10px var(--font-mono); letter-spacing: 0; text-transform: uppercase; }
	.artifact-card__chevron { margin-left: auto; color: var(--fg-3); font-size: 20px; line-height: 1; }
</style>
