import { describe, expect, it } from 'vitest';
import {
	ArtifactValidationError,
	parseArtifactSpec,
	serializeArtifactSpec,
	ARTIFACT_MAX_POINTS
} from './contracts';

const source = { id: 'rain', label: 'Environment Canada', period: '2026-09-01/2026-09-03' };

describe('artifact contracts', () => {
	it('accepts bounded charts with explicit missing periods and sources', () => {
		const spec = parseArtifactSpec({
			kind: 'chart',
			title: 'Rainfall',
			chartType: 'line',
			unit: 'mm',
			series: [{ id: 'toronto', label: 'Toronto', points: [{ period: '2026-09-01', value: 4.2, sourceId: 'rain' }, { period: '2026-09-02', value: null, status: 'missing', sourceId: 'rain' }] }],
			sources: [source],
			fixture: true
		});
		expect(spec.kind).toBe('chart');
		expect((spec as { series: Array<{ points: Array<{ value: number | null }> }> }).series[0].points[1].value).toBeNull();
		expect(serializeArtifactSpec(spec).sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it('rejects executable markdown and oversized series', () => {
		expect(() => parseArtifactSpec({ kind: 'markdown', title: 'x', markdown: '<script>alert(1)</script>' })).toThrow(ArtifactValidationError);
		expect(() => parseArtifactSpec({ kind: 'chart', title: 'x', chartType: 'line', series: [{ id: 's', label: 's', points: Array.from({ length: ARTIFACT_MAX_POINTS + 1 }, (_, index) => ({ period: String(index), value: index })) }] })).toThrow(/bounded/);
		expect(() => parseArtifactSpec({ kind: 'chart', title: 'x', chartType: 'line', series: [{ id: 's', label: 's', color: 'red;fill:url(http://bad)', points: [{ period: '1', value: 1 }] }] })).toThrow(/color/);
	});

	it('rejects out-of-range map coordinates and preserves layer metadata only', () => {
		expect(() => parseArtifactSpec({ kind: 'map', title: 'Map', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [181, 0] } }] })).toThrow(/coordinate/);
		const spec = parseArtifactSpec({ kind: 'map', title: 'Map', layers: [{ id: 'stations', label: 'Stations' }], features: [{ type: 'Feature', properties: { label: 'A', layer: 'stations', html: '<b>bad</b>' }, geometry: { type: 'Point', coordinates: [-79.38, 43.65] } }] });
		expect(spec.kind).toBe('map');
		expect((spec as { features: Array<{ properties?: Record<string, unknown> }> }).features[0].properties).toEqual({ label: 'A', layer: 'stations' });
	});
});
