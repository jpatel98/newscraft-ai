import { describe, expect, it } from 'vitest';
import { chartPresentationEdgeCaseFixture, rainfallDisplayVerificationFixture } from './ArtifactCanvas.fixtures';

describe('ArtifactCanvas display fixtures', () => {
	it('captures the observed rainfall display values without source claims', () => {
		const spec = rainfallDisplayVerificationFixture.spec;
		if (spec.kind !== 'chart') throw new Error('fixture must be a chart');
		expect(spec.fixture).toBe(true);
		expect(rainfallDisplayVerificationFixture.sourceMessageId).toBe('display-verification-snapshot');
		expect(spec.series[0].points.map((point) => point.value)).toEqual([181.8, 66.7, 103.8]);
		expect(spec.sources).toBeUndefined();
	});

	it('keeps edge-case periods and explicit statuses for renderer checks', () => {
		const spec = chartPresentationEdgeCaseFixture.spec;
		if (spec.kind !== 'chart') throw new Error('fixture must be a chart');
		expect(spec.series[0].points).toHaveLength(241);
		expect(spec.series[0].points[7]).toMatchObject({ value: null, status: 'missing' });
		expect(spec.series[0].points[19]).toMatchObject({ value: 0.0001, status: 'estimated' });
	});
});
