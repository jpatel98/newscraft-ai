import { describe, expect, it } from 'vitest';
import {
	CHART_FALLBACK_COLORS,
	chartDomain,
	chartPeriodsFor,
	chartTickIndices,
	chartTickValues,
	csvRow,
	chartSeriesColor,
	formatChartValue,
	validatedSourceUrl
} from './artifact-presentation';

describe('artifact presentation helpers', () => {
	it('keeps every chart period while sampling only axis labels', () => {
		const chart = {
			series: [
				{ id: 'rain', label: 'Rainfall', points: [{ period: '2024', value: 181.8 }, { period: '2025', value: 66.7 }] },
				{ id: 'snow', label: 'Snowfall', points: [{ period: '2025', value: 4 }, { period: '2026', value: null }] }
			]
		};
		expect(chartPeriodsFor(chart)).toEqual(['2024', '2025', '2026']);
		expect(chartTickIndices(3)).toEqual([0, 1, 2]);
		expect(chartTickIndices(100).at(-1)).toBe(99);
	});

	it('creates a usable domain and readable ticks for positive rainfall values', () => {
		const domain = chartDomain([181.8, 66.7, 103.8]);
		expect(domain).toEqual({ min: 0, max: 200 });
		expect(chartTickValues(domain)).toEqual([0, 50, 100, 150, 200]);
	});

	it('assigns distinct stable fallback colours', () => {
		expect(chartSeriesColor({}, 0)).toBe(CHART_FALLBACK_COLORS[0]);
		expect(chartSeriesColor({}, 1)).toBe(CHART_FALLBACK_COLORS[1]);
		expect(chartSeriesColor({ color: '#123456' }, 3)).toBe('#123456');
		expect(formatChartValue(0.0001)).toContain('0.0001');
	});

	it('quotes CSV cells without changing zeroes or embedded punctuation', () => {
		expect(csvRow(['period', 'series', 'value'])).toBe('period,series,value');
		expect(csvRow(['2026', 'Rain, total', 0])).toBe('2026,"Rain, total",0');
		expect(csvRow(['note', 'say "hi"\nnext', null])).toBe('note,"say ""hi""\nnext",');
	});

	it('accepts only provenance URLs covered by the citation contract', () => {
		expect(validatedSourceUrl('https://example.com/report')).toBe('https://example.com/report');
		expect(validatedSourceUrl('/api/conversations/c1/documents/d1')).toBe('/api/conversations/c1/documents/d1');
		expect(validatedSourceUrl('javascript:alert(1)')).toBeNull();
		expect(validatedSourceUrl('https://user:password@example.com/report')).toBeNull();
	});
});
