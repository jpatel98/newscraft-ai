<script lang="ts">
	import type { ArtifactDetail, ArtifactSpec, ChartArtifactSpec, MapArtifactSpec, TableArtifactSpec } from '$lib/types/artifacts';
	import X from 'lucide-svelte/icons/x';
	import Download from 'lucide-svelte/icons/download';
	import Table2 from 'lucide-svelte/icons/table-2';
	import ZoomIn from 'lucide-svelte/icons/zoom-in';
	import ZoomOut from 'lucide-svelte/icons/zoom-out';
	import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
	import {
		chartDomain as chartDomainFor,
		chartPeriodsFor,
		chartSeriesColor,
		chartTickIndices,
		chartTickValues,
		csvRow,
		formatChartValue,
		validatedSourceUrl
	} from '$lib/utils/artifact-presentation';

	interface Props { artifact: ArtifactDetail; conversationId: string; onClose: () => void; }
	let { artifact, conversationId, onClose }: Props = $props();
	let canvas = $state<HTMLElement | null>(null);
	let tableOpen = $state(false);
	let selectedSeries = $state(new Set<string>());
	let tooltip = $state<{ x: number; y: number; label: string; value: string; status?: string } | null>(null);
	let mapScale = $state(1);
	let mapOffset = $state({ x: 0, y: 0 });
	let mapDragging = $state(false);
	let mapDragStart = $state({ x: 0, y: 0 });
	let selectedFeature = $state<number | null>(null);
	function initialHiddenLayers(value: ArtifactSpec): Set<string> {
		return new Set(value.kind === 'map' ? (value.layers ?? []).filter((layer) => layer.visible === false).map((layer) => layer.id) : []);
	}
	let hiddenLayers = $state<Set<string>>(new Set());
	let hiddenLayerKey = $state('');
	let restoredFocus: HTMLElement | null = null;

	const spec = $derived(artifact.spec);
	const chart = $derived(spec.kind === 'chart' ? spec as ChartArtifactSpec : null);
	const table = $derived(spec.kind === 'table' ? spec as TableArtifactSpec : null);
	const map = $derived(spec.kind === 'map' ? spec as MapArtifactSpec : null);
	const visibleSeries = $derived(chart ? chart.series.filter((series) => !selectedSeries.has(series.id)) : []);
	const chartPoints = $derived(chart ? chart.series.flatMap((series) => series.points.filter((point) => point.value !== null).map((point) => ({ ...point, seriesId: series.id, label: series.label }))) : []);
	const chartPeriods = $derived(chart ? chartPeriodsFor(chart) : []);
	const values = $derived(chartPoints.map((point) => point.value as number));
	const domain = $derived(chartDomainFor(values));
	const yMin = $derived(domain.min);
	const yMax = $derived(domain.max);
	const yTicks = $derived(chart ? chartTickValues(domain) : []);
	const xTickIndices = $derived(chart ? chartTickIndices(chartPeriods.length) : []);
	const missingPointCount = $derived(chart ? chart.series.reduce((count, series) => count + series.points.filter((point) => point.value === null || point.status === 'missing').length, 0) : 0);
	const showBarLabels = $derived(chart?.chartType === 'bar' && chartPeriods.length <= 12);
	const asset = $derived(artifact.assets.find((candidate) => candidate.role === 'preview') ?? artifact.assets.find((candidate) => candidate.role === 'source'));
	const assetUrl = $derived(asset ? `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(artifact.id)}/revisions/${encodeURIComponent(artifact.revisionId)}/assets/${encodeURIComponent(asset.id)}` : null);

	const chartLeft = 72;
	const chartRight = 708;
	const chartTop = 44;
	const chartBottom = 280;

	function chartX(index: number): number {
		const periodCount = Math.max(chartPeriods.length, 1);
		// Bars represent categories, so place them in the middle of their bands
		// and leave equal breathing room at both edges. Lines retain endpoint alignment.
		const position = chart?.chartType === 'bar' ? (index + 0.5) / periodCount : index / Math.max(periodCount - 1, 1);
		return chartLeft + position * (chartRight - chartLeft);
	}
	function periodIndex(period: string): number | null {
		const index = chartPeriods.indexOf(period);
		return index >= 0 ? index : null;
	}
	function chartY(value: number): number {
		const range = yMax - yMin;
		return chartBottom - ((value - yMin) / (range > 0 ? range : 1)) * (chartBottom - chartTop);
	}
	function baselineY(): number { return chartY(0); }
	function seriesColor(series: ChartArtifactSpec['series'][number]): string {
		return chartSeriesColor(series, chart?.series.indexOf(series) ?? 0);
	}
	function pointStatus(point: ChartArtifactSpec['series'][number]['points'][number]): string {
		return point.status ?? (point.value === null ? 'missing' : 'observed');
	}
	function showPointTooltip(series: ChartArtifactSpec['series'][number], point: ChartArtifactSpec['series'][number]['points'][number], index: number): void {
		tooltip = {
			x: chartX(index),
			y: point.value === null ? chartBottom : chartY(point.value),
			label: `${series.label} · ${point.period}`,
			value: point.value === null ? 'Missing observation' : formatChartValue(point.value),
			status: point.value === null || point.status === 'estimated' ? pointStatus(point) : undefined
		};
	}
	function pointKeydown(event: KeyboardEvent, series: ChartArtifactSpec['series'][number], point: ChartArtifactSpec['series'][number]['points'][number], index: number): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		showPointTooltip(series, point, index);
	}
	function pathFor(series: ChartArtifactSpec['series'][number]): string {
		let connected = false;
		return series.points.flatMap((point) => {
			const index = periodIndex(point.period);
			if (index === null || point.value === null) {
				connected = false;
				return [];
			}
			const command = connected ? 'L' : 'M';
			connected = true;
			return [`${command} ${chartX(index).toFixed(1)} ${chartY(point.value).toFixed(1)}`];
		}).join(' ');
	}
	function areaPathFor(series: ChartArtifactSpec['series'][number]): string {
		const segments: string[] = [];
		let segment: Array<{ x: number; y: number }> = [];
		const flush = () => {
			if (!segment.length) return;
			const first = segment[0];
			const last = segment[segment.length - 1];
			segments.push([
				`M ${first.x.toFixed(1)} ${baselineY().toFixed(1)}`,
				...segment.map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`),
				`L ${last.x.toFixed(1)} ${baselineY().toFixed(1)} Z`
			].join(' '));
			segment = [];
		};
		for (const point of series.points) {
			const index = periodIndex(point.period);
			if (index === null || point.value === null) {
				flush();
				continue;
			}
			segment.push({ x: chartX(index), y: chartY(point.value) });
		}
		flush();
		return segments.join(' ');
	}
	function barWidth(seriesCount: number): number {
		const slotWidth = (chartRight - chartLeft) / Math.max(chartPeriods.length, 1);
		const groupWidth = Math.min(52, slotWidth * 0.78);
		return Math.max(3, Math.min(28, (groupWidth - 4) / Math.max(seriesCount, 1)));
	}
	function barX(index: number, seriesIndex: number, seriesCount: number): number {
		const width = barWidth(seriesCount);
		return chartX(index) - (width * seriesCount) / 2 + seriesIndex * width;
	}
	function barTop(value: number): number { return Math.min(chartY(value), baselineY()); }
	function barHeight(value: number): number { return Math.max(1, Math.abs(chartY(value) - baselineY())); }
	function toggleSeries(id: string) { const next = new Set(selectedSeries); next.has(id) ? next.delete(id) : next.add(id); selectedSeries = next; }
	function downloadData() {
		const body = table
			? [csvRow(table.columns.map((column) => column.label)), ...table.rows.map((row) => csvRow(table.columns.map((column) => row[column.id])))]
				.join('\n')
			: chart
				? [
						csvRow(['period', 'series', 'value', 'status']),
						...chart.series.flatMap((series) => series.points.map((point) => csvRow([
							point.period,
							series.label,
							point.value,
							point.status ?? (point.value === null ? 'missing' : 'observed')
						])))
					]
						.join('\n')
				: map
					? [
							csvRow(['id', 'label', 'layer', 'geometry']),
							...map.features.map((feature, index) => csvRow([
								feature.properties?.id ?? `feature-${index + 1}`,
								feature.properties?.label ?? '',
								feature.properties?.layer ?? '',
								feature.geometry.type
							]))
						]
							.join('\n')
					: '';
		if (!body) return;
		const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
		const link = document.createElement('a'); link.href = url; link.download = `${artifact.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'artifact'}.csv`; link.click(); URL.revokeObjectURL(url);
	}
	function featurePoints(feature: MapArtifactSpec['features'][number]): [number, number][] {
		const geometry = feature.geometry;
		if (geometry.type === 'Point') return [geometry.coordinates];
		if (geometry.type === 'LineString') return geometry.coordinates;
		return geometry.coordinates.flat();
	}
	function mapX(lon: number): number { return 360 + lon * 1.45 * mapScale + mapOffset.x; }
	function mapY(lat: number): number { return 190 - lat * 1.45 * mapScale + mapOffset.y; }
	function mapPointerDown(event: PointerEvent) { mapDragging = true; mapDragStart = { x: event.clientX - mapOffset.x, y: event.clientY - mapOffset.y }; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }
	function mapPointerMove(event: PointerEvent) { if (mapDragging) mapOffset = { x: event.clientX - mapDragStart.x, y: event.clientY - mapDragStart.y }; }
	function mapPointerUp() { mapDragging = false; }
	function resetMap() { mapScale = 1; mapOffset = { x: 0, y: 0 }; }
	function toggleLayer(id: string) { const next = new Set(hiddenLayers); next.has(id) ? next.delete(id) : next.add(id); hiddenLayers = next; }
	function keydown(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }

	$effect(() => {
		const nextHiddenLayerKey = `${artifact.id}:${artifact.revisionId}`;
		if (nextHiddenLayerKey !== hiddenLayerKey) {
			hiddenLayerKey = nextHiddenLayerKey;
			hiddenLayers = initialHiddenLayers(artifact.spec);
		}
		restoredFocus = document.activeElement as HTMLElement | null;
		void Promise.resolve().then(() => canvas?.focus());
		return () => { if (restoredFocus?.isConnected) restoredFocus.focus(); };
	});
</script>

<div class="canvas-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
	<dialog open class="artifact-canvas" bind:this={canvas} tabindex="-1" aria-modal="true" aria-labelledby="artifact-canvas-title" onkeydown={keydown}>
		<header class="artifact-canvas__header">
			<div><div class="artifact-canvas__eyebrow">Newsroom canvas {artifact.fixture ? '· synthetic fixture' : ''}</div><h2 id="artifact-canvas-title">{artifact.title}</h2><p>{artifact.kind} · revision {artifact.revision} · {artifact.status}</p></div>
			<button class="icon-button" type="button" aria-label="Close canvas" onclick={onClose}><X size="17" /></button>
		</header>
		{#if artifact.status === 'publishing' || artifact.status === 'draft'}
			<div class="canvas-state" role="status">Preparing this artifact. The written answer remains available.</div>
		{:else if artifact.status === 'failed' || artifact.status === 'cancelled' || artifact.status === 'missing'}
			<div class="canvas-state canvas-state--error" role="alert">{artifact.error?.message ?? 'This preview is unavailable. The written answer remains available.'}</div>
		{:else}
			<div class="canvas-toolbar">
				<span>{chart?.unit ?? (map?.subtitle ?? '')}</span>
				<div class="canvas-toolbar__actions">
					{#if chart || map}<button type="button" onclick={() => (tableOpen = !tableOpen)} aria-pressed={tableOpen}><Table2 size="14" /> {tableOpen ? 'Hide data' : 'View data'}</button>{/if}
					{#if chart || table || map}<button type="button" onclick={downloadData}><Download size="14" /> Download CSV</button>{/if}
				</div>
			</div>
			<div class="canvas-body">
				{#if chart && !tableOpen}
					<div class="legend" aria-label="Chart series">
						{#each chart.series as series (series.id)}<button type="button" class:legend--off={selectedSeries.has(series.id)} onclick={() => toggleSeries(series.id)} aria-pressed={!selectedSeries.has(series.id)}><span style={`--series-color:${seriesColor(series)}`}></span>{series.label}</button>{/each}
					</div>
					<div class="chart-wrap" role="group" aria-label={`${chart.title} chart${chart.unit ? ` in ${chart.unit}` : ''}. ${chartPeriods.length} periods across ${chart.series.length} series. ${missingPointCount} missing observations. Use View data for the accessible table.`}>
						<svg viewBox="0 0 760 340" class="chart">
							{#each yTicks as tick}
								{@const tickY = chartY(tick)}
								<line x1={chartLeft} y1={tickY} x2={chartRight} y2={tickY} class="gridline" />
								<text x={chartLeft - 10} y={tickY + 4} class="tick-label" text-anchor="end">{formatChartValue(tick)}</text>
							{/each}
							{#each xTickIndices as index}
								{@const tickX = chartX(index)}
								<line x1={tickX} y1={chartBottom} x2={tickX} y2={chartBottom + 5} class="axis" />
								<text x={tickX} y={chartBottom + 21} class="tick-label tick-label--period" text-anchor="middle">{chartPeriods[index]}</text>
							{/each}
							<line x1={chartLeft} y1={chartBottom} x2={chartRight} y2={chartBottom} class="axis" />
							<line x1={chartLeft} y1={chartTop} x2={chartLeft} y2={chartBottom} class="axis" />
							{#if yMin < 0 && yMax > 0}<line x1={chartLeft} y1={baselineY()} x2={chartRight} y2={baselineY()} class="zero-axis" />{/if}
							<text x="18" y={(chartTop + chartBottom) / 2} class="axis-label" text-anchor="middle" transform={`rotate(-90 18 ${(chartTop + chartBottom) / 2})`}>{chart.unit ?? 'Value'}</text>
							{#each visibleSeries as series, seriesIndex (series.id)}
								{#if chart.chartType === 'bar'}
									{#each series.points as point, index (index)}
										{@const period = periodIndex(point.period)}
										{#if period !== null && point.value !== null}
											<rect x={barX(period, seriesIndex, visibleSeries.length)} y={barTop(point.value)} width={barWidth(visibleSeries.length)} height={barHeight(point.value)} fill={seriesColor(series)} opacity=".86" role="button" aria-label={`${series.label} ${point.period}: ${formatChartValue(point.value)}${chart.unit ? ` ${chart.unit}` : ''}`} tabindex="0" onclick={() => showPointTooltip(series, point, period)} onmouseenter={() => showPointTooltip(series, point, period)} onmouseleave={() => (tooltip = null)} onfocus={() => showPointTooltip(series, point, period)} onblur={() => (tooltip = null)} onkeydown={(event) => pointKeydown(event, series, point, period)} />
											{#if showBarLabels}<text x={barX(period, seriesIndex, visibleSeries.length) + barWidth(visibleSeries.length) / 2} y={barTop(point.value) - 7} class="bar-value" text-anchor="middle">{formatChartValue(point.value)}</text>{/if}
										{/if}
										{#if period !== null && point.value === null}<circle cx={chartX(period)} cy={chartBottom} r="4" class="missing-point" role="button" aria-label={`${series.label} ${point.period}: missing observation`} tabindex="0" onclick={() => showPointTooltip(series, point, period)} onmouseenter={() => showPointTooltip(series, point, period)} onmouseleave={() => (tooltip = null)} onfocus={() => showPointTooltip(series, point, period)} onblur={() => (tooltip = null)} onkeydown={(event) => pointKeydown(event, series, point, period)} />{/if}
									{/each}
								{:else if chart.chartType === 'scatter'}
									{#each series.points as point, index (index)}
										{@const period = periodIndex(point.period)}
										{#if period !== null && point.value !== null}
											<circle cx={chartX(period)} cy={chartY(point.value)} r="4" fill={seriesColor(series)} opacity=".9" role="button" aria-label={`${series.label} ${point.period}: ${formatChartValue(point.value)}${chart.unit ? ` ${chart.unit}` : ''}`} tabindex="0" onclick={() => showPointTooltip(series, point, period)} onmouseenter={() => showPointTooltip(series, point, period)} onmouseleave={() => (tooltip = null)} onfocus={() => showPointTooltip(series, point, period)} onblur={() => (tooltip = null)} onkeydown={(event) => pointKeydown(event, series, point, period)} />
										{/if}
										{#if period !== null && point.value === null}<circle cx={chartX(period)} cy={chartBottom} r="4" class="missing-point" role="button" aria-label={`${series.label} ${point.period}: missing observation`} tabindex="0" onclick={() => showPointTooltip(series, point, period)} onmouseenter={() => showPointTooltip(series, point, period)} onmouseleave={() => (tooltip = null)} onfocus={() => showPointTooltip(series, point, period)} onblur={() => (tooltip = null)} onkeydown={(event) => pointKeydown(event, series, point, period)} />{/if}
									{/each}
								{:else}
									<path d={chart.chartType === 'area' ? areaPathFor(series) : pathFor(series)} fill={chart.chartType === 'area' ? seriesColor(series) : 'none'} fill-opacity={chart.chartType === 'area' ? 0.12 : 0} stroke={seriesColor(series)} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
									{#each series.points as point, index (index)}
										{@const period = periodIndex(point.period)}
										{#if period !== null && point.value !== null}<circle cx={chartX(period)} cy={chartY(point.value)} r="4" class="chart-point" fill={seriesColor(series)} role="button" aria-label={`${series.label} ${point.period}: ${formatChartValue(point.value)}${chart.unit ? ` ${chart.unit}` : ''}`} tabindex="0" onclick={() => showPointTooltip(series, point, period)} onmouseenter={() => showPointTooltip(series, point, period)} onmouseleave={() => (tooltip = null)} onfocus={() => showPointTooltip(series, point, period)} onblur={() => (tooltip = null)} onkeydown={(event) => pointKeydown(event, series, point, period)} />{/if}
										{#if period !== null && point.value === null}<circle cx={chartX(period)} cy={chartBottom} r="4" class="missing-point" role="button" aria-label={`${series.label} ${point.period}: missing observation`} tabindex="0" onclick={() => showPointTooltip(series, point, period)} onmouseenter={() => showPointTooltip(series, point, period)} onmouseleave={() => (tooltip = null)} onfocus={() => showPointTooltip(series, point, period)} onblur={() => (tooltip = null)} onkeydown={(event) => pointKeydown(event, series, point, period)} />{/if}
									{/each}
								{/if}
							{/each}
						</svg>
						{#if tooltip}<div class="tooltip" style={`left:${(tooltip.x / 760) * 100}%; top:${(tooltip.y / 340) * 100}%`} role="status">{tooltip.label}<strong>{tooltip.value}</strong>{#if tooltip.status}<small>{tooltip.status}</small>{/if}</div>{/if}
					</div>
					{#if missingPointCount}<p class="chart-note"><span class="missing-key" aria-hidden="true"></span>{missingPointCount} missing observation{missingPointCount === 1 ? '' : 's'} {missingPointCount === 1 ? 'is' : 'are'} shown as gaps with a marked period.</p>{/if}
				{:else if table}
					<div class="table-scroll"><table><caption>{table.title}</caption><thead><tr>{#each table.columns as column}<th class:table-cell--number={column.type === 'number'} scope="col">{column.label}</th>{/each}</tr></thead><tbody>{#each table.rows as row}<tr>{#each table.columns as column}<td class:table-cell--number={column.type === 'number'}>{row[column.id] ?? '—'}</td>{/each}</tr>{/each}</tbody></table></div>
				{:else if map && !tableOpen}
					<div class="map-controls"><button type="button" aria-label="Zoom in" onclick={() => (mapScale = Math.min(3, mapScale + 0.25))}><ZoomIn size="14" /></button><button type="button" aria-label="Zoom out" onclick={() => (mapScale = Math.max(0.75, mapScale - 0.25))}><ZoomOut size="14" /></button><button type="button" onclick={resetMap}><RotateCcw size="14" /> Reset</button>{#each map.layers ?? [] as layer (layer.id)}<button type="button" class:layer--off={hiddenLayers.has(layer.id)} aria-pressed={!hiddenLayers.has(layer.id)} onclick={() => toggleLayer(layer.id)}>{layer.label}</button>{/each}</div>
					<div class="map-wrap" role="application" aria-label={`${map.title} map. Use the table view for keyboard data access.`} onpointerdown={mapPointerDown} onpointermove={mapPointerMove} onpointerup={mapPointerUp} onpointercancel={mapPointerUp}>
						<svg viewBox="0 0 720 380" class="map" aria-hidden="true"><rect x="0" y="0" width="720" height="380" rx="12" class="map-bg" />{#each map.features as feature, index (index)}{@const points = featurePoints(feature)}{@const layer = feature.properties?.layer}{#if !layer || !hiddenLayers.has(layer)}{#if feature.geometry.type === 'Point'}<circle cx={mapX(points[0][0])} cy={mapY(points[0][1])} r={selectedFeature === index ? 8 : 5} class="map-point" class:map-point--selected={selectedFeature === index} tabindex="0" role="button" aria-label={feature.properties?.label ?? `Marker ${index + 1}`} onclick={() => (selectedFeature = index)} onkeydown={(event) => event.key === 'Enter' && (selectedFeature = index)} />{:else}<polyline points={points.map((point) => `${mapX(point[0])},${mapY(point[1])}`).join(' ')} class="map-line" />{/if}{/if}{/each}</svg>
					</div>
					{#if selectedFeature !== null}<div class="map-selection" role="status">{map.features[selectedFeature]?.properties?.label ?? `Marker ${selectedFeature + 1}`} selected</div>{/if}
				{:else if map && tableOpen}
					<div class="table-scroll"><table><caption>{map.title} data</caption><thead><tr><th scope="col">Feature</th><th scope="col">Label</th><th scope="col">Layer</th><th scope="col">Geometry</th></tr></thead><tbody>{#each map.features as feature, index}<tr><th scope="row">{feature.properties?.id ?? `feature-${index + 1}`}</th><td>{feature.properties?.label ?? '—'}</td><td>{feature.properties?.layer ?? '—'}</td><td>{feature.geometry.type}</td></tr>{/each}</tbody></table></div>
				{:else if spec.kind === 'image'}
					{#if assetUrl}<img class="artifact-image" src={assetUrl} alt={spec.alt} />{:else}<div class="canvas-state">Image asset is missing.</div>{/if}
				{:else if spec.kind === 'markdown'}
					<pre class="markdown-preview">{spec.markdown}</pre>
				{/if}
				{#if tableOpen && chart}
					<div class="table-scroll table-scroll--secondary"><table><caption>Data table · all {chartPeriods.length} periods</caption><thead><tr><th scope="col">Period</th>{#each chart.series as series}<th scope="col" class="table-cell--number">{series.label}{chart.unit ? ` (${chart.unit})` : ''}</th>{/each}</tr></thead><tbody>{#each chartPeriods as period}<tr><th scope="row">{period}</th>{#each chart.series as series}<td class="table-cell--number">{series.points.find((point) => point.period === period)?.value ?? 'Missing'}</td>{/each}</tr>{/each}</tbody></table></div>
				{/if}
			</div>
			{#if spec.sources?.length}<footer class="sources"><strong>Sources</strong>{#each spec.sources as source}{@const sourceHref = validatedSourceUrl(source.url)}{#if sourceHref}<a href={sourceHref} target="_blank" rel="noopener noreferrer">{source.label}{source.period ? ` · ${source.period}` : ''}</a>{:else}<span>{source.label}{source.period ? ` · ${source.period}` : ''}</span>{/if}{/each}</footer>{/if}
		{/if}
	</dialog>
</div>

<style>
	.canvas-backdrop { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; min-width: 0; padding: 22px; background: rgb(15 23 42 / 28%); }
	.artifact-canvas { position: relative; inset: auto; box-sizing: border-box; width: min(980px, calc(100vw - 44px)); max-width: 100%; max-height: min(860px, calc(100vh - 44px)); margin: 0; padding: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface); color: var(--fg-1); box-shadow: var(--shadow-3); }
	.artifact-canvas:focus { outline: none; }
	.artifact-canvas__header { display: flex; justify-content: space-between; gap: 14px; padding: 18px 20px 14px; border-bottom: 1px solid var(--border-default); }
	.artifact-canvas__eyebrow { color: var(--accent-fg); font: 10px var(--font-mono); letter-spacing: .05em; text-transform: uppercase; }
	.artifact-canvas h2 { margin: 4px 0 0; font: 650 21px/1.2 var(--font-display); }
	.artifact-canvas__header p { margin: 5px 0 0; color: var(--fg-3); font: 10px var(--font-mono); text-transform: uppercase; }
	.icon-button { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--border-default); border-radius: 8px; background: transparent; color: var(--fg-2); cursor: pointer; }
	.canvas-toolbar { display: flex; justify-content: space-between; gap: 12px; padding: 10px 20px; color: var(--fg-3); font: 10px var(--font-mono); text-transform: uppercase; }
	.canvas-toolbar__actions, .map-controls { display: flex; flex-wrap: wrap; gap: 6px; }
	.canvas-toolbar button, .map-controls button { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 0 9px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-page); color: var(--fg-2); font: 10px var(--font-mono); cursor: pointer; }
	.canvas-body { min-width: 0; min-height: 0; overflow: auto; padding: 4px 20px 20px; }
	.canvas-state { margin: 16px 20px; padding: 12px; border: 1px solid var(--border-default); border-radius: 8px; color: var(--fg-2); font-size: 13px; }
	.canvas-state--error { border-color: color-mix(in srgb, #b42318 30%, var(--border-default)); color: #9b2c2c; }
	.legend { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px; }
	.legend button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--border-soft); border-radius: 6px; background: var(--bg-page); color: var(--fg-2); font: 10px var(--font-mono); cursor: pointer; }
	.legend span { width: 8px; height: 8px; border-radius: 50%; background: var(--series-color); }
	.legend--off { opacity: .45; text-decoration: line-through; }
	.chart-wrap { position: relative; min-height: 340px; overflow-x: auto; }
	.chart { display: block; width: 100%; min-width: 0; height: auto; background: color-mix(in srgb, var(--bg-page) 76%, transparent); border-radius: 10px; }
	.gridline { stroke: var(--border-soft); stroke-width: 1; }
	.axis { stroke: var(--border-strong); stroke-width: 1; }
	.zero-axis { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 4 4; opacity: .8; }
	.axis-label, .tick-label { fill: var(--fg-3); font: 10px var(--font-mono); }
	.tick-label--period { fill: var(--fg-2); }
	.bar-value { fill: var(--fg-2); font: 10px var(--font-mono); }
	.chart-point { stroke: var(--bg-surface); stroke-width: 1.5; cursor: pointer; }
	.chart-point:focus, .missing-point:focus { outline: none; stroke: var(--fg-1); stroke-width: 2; }
	.missing-point { fill: var(--bg-surface); stroke: var(--fg-3); stroke-width: 1.5; stroke-dasharray: 2 2; cursor: pointer; }
	.chart-note { display: flex; align-items: center; gap: 6px; margin: 7px 0 0; color: var(--fg-3); font: 10px/1.4 var(--font-mono); }
	.missing-key { width: 8px; height: 8px; display: inline-block; border: 1px dashed var(--fg-3); border-radius: 50%; }
	.tooltip { position: absolute; transform: translate(-50%, -100%); padding: 6px 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-surface); box-shadow: var(--shadow-2); color: var(--fg-2); font: 10px var(--font-mono); pointer-events: none; white-space: nowrap; }
	.tooltip strong { display: block; margin-top: 2px; color: var(--fg-1); font-size: 12px; }
	.tooltip small { display: block; margin-top: 2px; color: var(--fg-3); text-transform: uppercase; }
	.table-scroll { max-height: 560px; overflow: auto; border: 1px solid var(--border-default); border-radius: 8px; }
	table { width: 100%; border-collapse: collapse; font-size: 12px; }
	caption { padding: 8px 10px; text-align: left; color: var(--fg-3); font: 10px var(--font-mono); text-transform: uppercase; }
	thead { position: sticky; top: 0; z-index: 1; background: var(--bg-surface); }
	th, td { padding: 8px 10px; border-top: 1px solid var(--border-soft); text-align: left; white-space: nowrap; }
	th { color: var(--fg-2); font-weight: 650; }
	.table-cell--number { text-align: right; font-variant-numeric: tabular-nums; }
	.map-controls { margin-bottom: 8px; }
	.layer--off { opacity: .45; }
	.map-wrap { overflow: hidden; border: 1px solid var(--border-default); border-radius: 10px; cursor: grab; touch-action: none; }
	.map-wrap:active { cursor: grabbing; }
	.map { display: block; width: 100%; min-width: 560px; height: auto; }
	.map-bg { fill: color-mix(in srgb, var(--cobalt-100) 42%, var(--bg-page)); }
	.map-point { fill: #c34a32; stroke: var(--bg-surface); stroke-width: 2; cursor: pointer; }
	.map-point--selected { fill: var(--cobalt-700); }
	.map-line { fill: none; stroke: var(--cobalt-700); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; opacity: .8; }
	.map-selection { margin-top: 8px; padding: 8px 10px; border-radius: 7px; background: var(--bg-raised); color: var(--fg-2); font: 11px var(--font-mono); }
	.artifact-image { display: block; max-width: 100%; max-height: 560px; margin: 0 auto; object-fit: contain; border-radius: 8px; }
	.markdown-preview { white-space: pre-wrap; font: 13px/1.55 var(--font-mono); }
	.sources { display: flex; flex-wrap: wrap; gap: 8px 14px; padding: 10px 20px; border-top: 1px solid var(--border-default); color: var(--fg-3); font: 10px var(--font-mono); }
	.sources strong { color: var(--fg-2); }
	.sources a { color: var(--accent-fg); text-decoration: underline; text-underline-offset: 2px; }
	@media (max-width: 700px) { .canvas-backdrop { align-items: stretch; padding: 0; } .artifact-canvas { width: 100%; max-height: 100%; border-radius: 0; border-inline: 0; } .artifact-canvas__header { padding-top: calc(14px + env(safe-area-inset-top, 0px)); } .canvas-body { padding-inline: 12px; } .canvas-toolbar { padding-inline: 12px; align-items: flex-start; flex-direction: column; } .chart-wrap { min-height: 0; } .chart { min-width: 0; } .chart .axis-label, .chart .tick-label { font-size: 22px; } .chart .bar-value { font-size: 20px; } .sources { padding-inline: 12px; padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); } }
</style>
