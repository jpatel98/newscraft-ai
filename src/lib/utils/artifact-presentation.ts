import { isCitationUrl } from '@newscraft/shared';
import type { ChartArtifactSpec, ChartSeries } from '$lib/types/artifacts';

/** A small, high-contrast palette used when a producer did not provide a series colour. */
export const CHART_FALLBACK_COLORS = ['#2857c5', '#c34a32', '#16805d', '#8a5a00', '#7a3e9d', '#006b8f'] as const;

export interface ChartDomain {
	min: number;
	max: number;
}

export function chartSeriesColor(series: Pick<ChartSeries, 'color'>, index: number): string {
	return series.color?.trim() || CHART_FALLBACK_COLORS[index % CHART_FALLBACK_COLORS.length];
}

/** Keep every period in the data model; callers can sample only the axis labels. */
export function chartPeriodsFor(chart: Pick<ChartArtifactSpec, 'series'>): string[] {
	const periods: string[] = [];
	const seen = new Set<string>();
	for (const series of chart.series) {
		for (const point of series.points) {
			if (seen.has(point.period)) continue;
			seen.add(point.period);
			periods.push(point.period);
		}
	}
	return periods;
}

export function chartDomain(values: readonly number[]): ChartDomain {
	const finite = values.filter((value): value is number => Number.isFinite(value));
	if (!finite.length) return { min: 0, max: 1 };
	let min = Math.min(0, ...finite);
	let max = Math.max(0, ...finite);
	if (min === max) {
		const padding = Math.max(Math.abs(min) * 0.25, 1);
		min -= padding;
		max += padding;
	}
	const roughStep = (max - min) / 4;
	const exponent = Math.floor(Math.log10(roughStep));
	const magnitude = 10 ** exponent;
	const fraction = roughStep / magnitude;
	const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
	const step = niceFraction * magnitude;
	return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step };
}

export function chartTickIndices(periodCount: number, maxTicks = 8): number[] {
	if (periodCount <= 0) return [];
	if (periodCount <= maxTicks) return Array.from({ length: periodCount }, (_, index) => index);
	const count = Math.max(2, Math.floor(maxTicks));
	const last = periodCount - 1;
	return Array.from({ length: count }, (_, index) => Math.round((index * last) / (count - 1)));
}

export function chartTickValues(domain: ChartDomain, count = 5): number[] {
	const tickCount = Math.max(2, Math.floor(count));
	const step = (domain.max - domain.min) / (tickCount - 1);
	const precision = Math.max(0, Math.min(12, Math.ceil(-Math.log10(Math.abs(step))) + 2));
	return Array.from({ length: tickCount }, (_, index) => {
		const value = Number((domain.min + step * index).toFixed(precision));
		return Math.abs(value) < 1e-10 ? 0 : value;
	});
}

export function formatChartValue(value: number): string {
	if (!Number.isFinite(value)) return '—';
	const magnitude = Math.abs(value);
	const maximumFractionDigits = magnitude > 0 && magnitude < 1 ? Math.min(8, Math.max(2, Math.ceil(-Math.log10(magnitude)) + 2)) : 2;
	return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

/** CSV quoting follows RFC 4180 and preserves commas, quotes, line breaks, and zeroes. */
export function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: readonly unknown[]): string {
	return values.map(csvCell).join(',');
}

/** Use the same citation URL contract as answer provenance and markdown rendering. */
export function validatedSourceUrl(raw: string | undefined): string | null {
	const value = raw?.trim();
	if (!value || !isCitationUrl(value) || /[\u0000-\u0020<>"']/.test(value)) return null;
	if (value.startsWith('/api/')) return value;
	if (/^https?:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			if (url.username || url.password) return null;
			return url.toString();
		} catch {
			return null;
		}
	}
	return value;
}
