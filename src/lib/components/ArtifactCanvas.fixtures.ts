import type { ArtifactDetail } from '$lib/types/artifacts';

/**
 * Values observed in the live display check on 2026-09-08. This is a rendering
 * snapshot only; it is not an independent source or weather-data validation.
 */
export const rainfallDisplayVerificationFixture: ArtifactDetail = {
	id: 'display-verification-rainfall-2024-2026',
	revisionId: 'display-verification-rainfall-revision-1',
	revision: 1,
	kind: 'chart',
	title: 'Total rainfall in August — Toronto Pearson, 2024–2026',
	status: 'ready',
	sourceMessageId: 'display-verification-snapshot',
	createdAt: 0,
	updatedAt: 0,
	fixture: true,
	spec: {
		kind: 'chart',
		title: 'Total rainfall in August — Toronto Pearson, 2024–2026',
		chartType: 'bar',
		unit: 'mm',
		series: [{
			id: 'total-rainfall',
			label: 'Total rainfall',
			unit: 'mm',
			points: [
				{ period: '2024', value: 181.8, status: 'observed' },
				{ period: '2025', value: 66.7, status: 'observed' },
				{ period: '2026', value: 103.8, status: 'observed' }
			]
		}],
		fixture: true
	},
	assets: []
};

/** Synthetic edge case for local renderer checks: a gap, an estimate, and many periods. */
export const chartPresentationEdgeCaseFixture: ArtifactDetail = {
	id: 'synthetic-chart-presentation-edge-case',
	revisionId: 'synthetic-chart-presentation-edge-case-revision-1',
	revision: 1,
	kind: 'chart',
	title: 'Synthetic chart presentation edge case',
	status: 'ready',
	sourceMessageId: 'synthetic-edge-case',
	createdAt: 0,
	updatedAt: 0,
	fixture: true,
	spec: {
		kind: 'chart',
		title: 'Synthetic chart presentation edge case',
		chartType: 'line',
		unit: 'index points',
		series: [
			{
				id: 'observed',
				label: 'Observed',
				points: Array.from({ length: 241 }, (_, index) => ({
					period: `P${String(index + 1).padStart(3, '0')}`,
					value: index === 7 ? null : index === 19 ? 0.0001 : Math.sin(index / 12) * 10,
					status: index === 7 ? 'missing' : index === 19 ? 'estimated' : 'observed'
				}))
			}
		],
		fixture: true
	},
	assets: []
};
