import { createHash } from 'node:crypto';

export const ARTIFACT_MAX_SPEC_BYTES = 32 * 1024;
export const ARTIFACT_MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
export const ARTIFACT_MAX_ROWS = 5000;
export const ARTIFACT_MAX_COLUMNS = 32;
export const ARTIFACT_MAX_SERIES = 12;
export const ARTIFACT_MAX_POINTS = 5000;
export const ARTIFACT_MAX_FEATURES = 2000;
export const ARTIFACT_MAX_GEOMETRY_BYTES = 256 * 1024;

export type ArtifactKind = 'chart' | 'table' | 'image' | 'markdown' | 'map';
export type ArtifactStatus = 'draft' | 'publishing' | 'ready' | 'failed' | 'cancelled' | 'missing';
export type ArtifactAssetRole = 'source' | 'preview' | 'data';

export interface ArtifactSource {
	id: string;
	label: string;
	url?: string;
	period?: string;
	publicationDate?: string | null;
	updatedAt?: string | null;
}

export interface ChartPoint {
	period: string;
	value: number | null;
	status?: 'observed' | 'missing' | 'estimated';
	sourceId?: string;
}

export interface ChartSeries {
	id: string;
	label: string;
	unit?: string;
	color?: string;
	points: ChartPoint[];
}

export interface ChartArtifactSpec {
	kind: 'chart';
	title: string;
	subtitle?: string;
	chartType: 'line' | 'bar' | 'area' | 'scatter';
	unit?: string;
	series: ChartSeries[];
	sources?: ArtifactSource[];
	fixture?: boolean;
}

export interface TableArtifactSpec {
	kind: 'table';
	title: string;
	columns: Array<{ id: string; label: string; type?: 'text' | 'number' | 'date' }>;
	rows: Array<Record<string, string | number | null>>;
	sources?: ArtifactSource[];
	fixture?: boolean;
}

export interface ImageArtifactSpec {
	kind: 'image';
	title: string;
	alt: string;
	caption?: string;
	sources?: ArtifactSource[];
	fixture?: boolean;
}

export interface MarkdownArtifactSpec {
	kind: 'markdown';
	title: string;
	markdown: string;
	sources?: ArtifactSource[];
	fixture?: boolean;
}

export interface MapFeature {
	type: 'Feature';
	properties?: { id?: string; label?: string; layer?: string; [key: string]: unknown };
	geometry:
		| { type: 'Point'; coordinates: [number, number] }
		| { type: 'LineString'; coordinates: [number, number][] }
		| { type: 'Polygon'; coordinates: [number, number][][] };
}

export interface MapArtifactSpec {
	kind: 'map';
	title: string;
	subtitle?: string;
	features: MapFeature[];
	layers?: Array<{ id: string; label: string; visible?: boolean }>;
	sources?: ArtifactSource[];
	fixture?: boolean;
}

export type ArtifactSpec =
	| ChartArtifactSpec
	| TableArtifactSpec
	| ImageArtifactSpec
	| MarkdownArtifactSpec
	| MapArtifactSpec;

export interface ArtifactSummary {
	id: string;
	revisionId: string;
	revision: number;
	kind: ArtifactKind;
	title: string;
	status: ArtifactStatus;
	sourceMessageId: string;
	createdAt: number;
	updatedAt: number;
	fixture?: boolean;
	preview?: { assetId: string; mimeType: string; sizeBytes: number; width?: number | null; height?: number | null } | null;
	error?: { code: string; message: string } | null;
}

export interface ArtifactDetail extends ArtifactSummary {
	spec: ArtifactSpec;
	assets: Array<{
		id: string;
		role: ArtifactAssetRole;
		mimeType: string;
		sizeBytes: number;
		checksumSha256: string;
		width?: number | null;
		height?: number | null;
		objectVersion: string;
	}>;
}

export class ArtifactValidationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'ArtifactValidationError';
		this.code = code;
	}
}

function boundedString(value: unknown, label: string, max: number, required = true): string {
	if (typeof value !== 'string') {
		if (!required && (value === undefined || value === null)) return '';
		throw new ArtifactValidationError('invalid_spec', `${label} must be text`);
	}
	const result = value.trim();
	if (required && !result) throw new ArtifactValidationError('invalid_spec', `${label} is required`);
	if (result.length > max) throw new ArtifactValidationError('invalid_spec', `${label} is too long`);
	return result;
}

function finiteNumber(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e15) {
		throw new ArtifactValidationError('invalid_spec', `${label} must be a finite bounded number`);
	}
	return value;
}

function sources(value: unknown): ArtifactSource[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 64) throw new ArtifactValidationError('invalid_spec', 'sources are bounded');
	return value.map((raw, index) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('invalid_spec', `source ${index + 1} is invalid`);
		const item = raw as Record<string, unknown>;
		return {
			id: boundedString(item.id, `source ${index + 1} id`, 160),
			label: boundedString(item.label, `source ${index + 1} label`, 200),
			...(item.url === undefined ? {} : { url: boundedString(item.url, `source ${index + 1} URL`, 2_000) }),
			...(item.period === undefined ? {} : { period: boundedString(item.period, `source ${index + 1} period`, 120) }),
			publicationDate: item.publicationDate === null ? null : item.publicationDate === undefined ? undefined : boundedString(item.publicationDate, `source ${index + 1} publication date`, 80),
			updatedAt: item.updatedAt === null ? null : item.updatedAt === undefined ? undefined : boundedString(item.updatedAt, `source ${index + 1} update date`, 80)
		};
	});
}

function chartSpec(value: Record<string, unknown>): ChartArtifactSpec {
	const type = boundedString(value.chartType, 'chartType', 16) as ChartArtifactSpec['chartType'];
	if (!['line', 'bar', 'area', 'scatter'].includes(type)) throw new ArtifactValidationError('invalid_spec', 'chartType is unsupported');
	if (!Array.isArray(value.series) || value.series.length < 1 || value.series.length > ARTIFACT_MAX_SERIES) {
		throw new ArtifactValidationError('invalid_spec', `series must contain 1..${ARTIFACT_MAX_SERIES} items`);
	}
	let pointCount = 0;
	const series = value.series.map((raw, seriesIndex) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('invalid_spec', `series ${seriesIndex + 1} is invalid`);
		const item = raw as Record<string, unknown>;
		if (!Array.isArray(item.points) || item.points.length > ARTIFACT_MAX_POINTS) throw new ArtifactValidationError('invalid_spec', 'chart points are bounded');
		pointCount += item.points.length;
		if (pointCount > ARTIFACT_MAX_POINTS) throw new ArtifactValidationError('invalid_spec', 'chart points are bounded');
		const color = item.color === undefined ? undefined : boundedString(item.color, `series ${seriesIndex + 1} color`, 32);
		if (color && !/^(?:#[0-9a-fA-F]{3,8}|[A-Za-z]{1,32})$/u.test(color)) {
			throw new ArtifactValidationError('invalid_spec', `series ${seriesIndex + 1} color is invalid`);
		}
		return {
			id: boundedString(item.id, `series ${seriesIndex + 1} id`, 80),
			label: boundedString(item.label, `series ${seriesIndex + 1} label`, 120),
			...(item.unit === undefined ? {} : { unit: boundedString(item.unit, `series ${seriesIndex + 1} unit`, 80) }),
			...(color === undefined ? {} : { color }),
			points: item.points.map((pointRaw, pointIndex) => {
				if (!pointRaw || typeof pointRaw !== 'object' || Array.isArray(pointRaw)) throw new ArtifactValidationError('invalid_spec', `point ${pointIndex + 1} is invalid`);
				const point = pointRaw as Record<string, unknown>;
				const status = point.status === undefined ? undefined : boundedString(point.status, 'point status', 16) as ChartPoint['status'];
				if (status && !['observed', 'missing', 'estimated'].includes(status)) throw new ArtifactValidationError('invalid_spec', 'point status is invalid');
				return {
					period: boundedString(point.period, 'point period', 120),
					value: point.value === null || point.value === undefined ? null : finiteNumber(point.value, 'point value'),
					...(status ? { status } : {}),
					...(point.sourceId === undefined ? {} : { sourceId: boundedString(point.sourceId, 'point sourceId', 160) })
				};
			})
		};
	});
	return {
		kind: 'chart',
		title: boundedString(value.title, 'title', 200),
		...(value.subtitle === undefined ? {} : { subtitle: boundedString(value.subtitle, 'subtitle', 240) }),
		chartType: type,
		...(value.unit === undefined ? {} : { unit: boundedString(value.unit, 'unit', 80) }),
		series,
		...(value.sources === undefined ? {} : { sources: sources(value.sources) }),
		...(value.fixture === true ? { fixture: true } : {})
	};
}

function tableSpec(value: Record<string, unknown>): TableArtifactSpec {
	if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > ARTIFACT_MAX_COLUMNS) throw new ArtifactValidationError('invalid_spec', 'table columns are bounded');
	if (!Array.isArray(value.rows) || value.rows.length > ARTIFACT_MAX_ROWS) throw new ArtifactValidationError('invalid_spec', 'table rows are bounded');
	const columns = value.columns.map((raw, index) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('invalid_spec', 'table column is invalid');
		const col = raw as Record<string, unknown>;
		const type = col.type === undefined ? undefined : boundedString(col.type, 'column type', 16) as 'text' | 'number' | 'date';
		if (type && !['text', 'number', 'date'].includes(type)) throw new ArtifactValidationError('invalid_spec', 'column type is invalid');
		return { id: boundedString(col.id, `column ${index + 1} id`, 80), label: boundedString(col.label, `column ${index + 1} label`, 120), ...(type ? { type } : {}) };
	});
	const ids = new Set(columns.map((column) => column.id));
	const rows = value.rows.map((raw, rowIndex) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('invalid_spec', `row ${rowIndex + 1} is invalid`);
		const row: Record<string, string | number | null> = {};
		for (const [key, cell] of Object.entries(raw as Record<string, unknown>)) {
			if (!ids.has(key)) continue;
			if (cell !== null && typeof cell !== 'string' && typeof cell !== 'number') throw new ArtifactValidationError('invalid_spec', 'table cells must be text, number, or null');
			if (typeof cell === 'string' && cell.length > 2_000) throw new ArtifactValidationError('invalid_spec', 'table cell is too long');
			if (typeof cell === 'number') finiteNumber(cell, 'table value');
			row[key] = cell as string | number | null;
		}
		return row;
	});
	return { kind: 'table', title: boundedString(value.title, 'title', 200), columns, rows, ...(value.sources === undefined ? {} : { sources: sources(value.sources) }), ...(value.fixture === true ? { fixture: true } : {}) };
}

function mapSpec(value: Record<string, unknown>): MapArtifactSpec {
	if (!Array.isArray(value.features) || value.features.length > ARTIFACT_MAX_FEATURES) throw new ArtifactValidationError('invalid_spec', 'map features are bounded');
	let geometryBytes = 0;
	const features = value.features.map((raw, index) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('invalid_spec', `feature ${index + 1} is invalid`);
		const feature = raw as Record<string, unknown>;
		if (feature.type !== 'Feature' || !feature.geometry || typeof feature.geometry !== 'object') throw new ArtifactValidationError('invalid_spec', `feature ${index + 1} is invalid`);
		const geometry = feature.geometry as Record<string, unknown>;
		const geometryJson = JSON.stringify(geometry);
		geometryBytes += Buffer.byteLength(geometryJson, 'utf8');
		if (geometryBytes > ARTIFACT_MAX_GEOMETRY_BYTES) throw new ArtifactValidationError('invalid_spec', 'map geometry is too large');
		const type = geometry.type;
		if (!['Point', 'LineString', 'Polygon'].includes(String(type))) throw new ArtifactValidationError('invalid_spec', 'map geometry type is unsupported');
		const coordinates = geometry.coordinates;
		const checkPair = (pair: unknown): [number, number] => {
			if (!Array.isArray(pair) || pair.length < 2) throw new ArtifactValidationError('invalid_spec', 'map coordinate is invalid');
			const lon = finiteNumber(pair[0], 'longitude');
			const lat = finiteNumber(pair[1], 'latitude');
			if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new ArtifactValidationError('invalid_spec', 'map coordinate is out of range');
			return [lon, lat];
		};
		let safeGeometry: MapFeature['geometry'];
		if (type === 'Point') safeGeometry = { type: 'Point', coordinates: checkPair(coordinates) };
		else if (type === 'LineString') {
			if (!Array.isArray(coordinates) || coordinates.length > 1000) throw new ArtifactValidationError('invalid_spec', 'map line is bounded');
			safeGeometry = { type: 'LineString', coordinates: coordinates.map(checkPair) };
		} else {
			if (!Array.isArray(coordinates) || coordinates.length > 100) throw new ArtifactValidationError('invalid_spec', 'map polygon is bounded');
			const safeRings = coordinates.map((ring) => {
				if (!Array.isArray(ring) || ring.length > 1000) throw new ArtifactValidationError('invalid_spec', 'map polygon ring is bounded');
				return ring.map(checkPair);
			});
			safeGeometry = { type: 'Polygon', coordinates: safeRings };
		}
		const properties = feature.properties && typeof feature.properties === 'object' && !Array.isArray(feature.properties) ? feature.properties as Record<string, unknown> : {};
		return {
			type: 'Feature' as const,
			properties: {
				...(properties.id === undefined ? {} : { id: boundedString(properties.id, 'feature id', 120) }),
				...(properties.label === undefined ? {} : { label: boundedString(properties.label, 'feature label', 200) }),
				...(properties.layer === undefined ? {} : { layer: boundedString(properties.layer, 'feature layer', 80) })
			},
			geometry: safeGeometry
		};
	});
	const layers = value.layers === undefined ? undefined : (() => {
		if (!Array.isArray(value.layers) || value.layers.length > 32) throw new ArtifactValidationError('invalid_spec', 'map layers are bounded');
		return value.layers.map((raw, index) => {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ArtifactValidationError('invalid_spec', 'map layer is invalid');
			const layer = raw as Record<string, unknown>;
			return { id: boundedString(layer.id, `layer ${index + 1} id`, 80), label: boundedString(layer.label, `layer ${index + 1} label`, 120), visible: layer.visible !== false };
		});
	})();
	return { kind: 'map', title: boundedString(value.title, 'title', 200), ...(value.subtitle === undefined ? {} : { subtitle: boundedString(value.subtitle, 'subtitle', 240) }), features, ...(layers ? { layers } : {}), ...(value.sources === undefined ? {} : { sources: sources(value.sources) }), ...(value.fixture === true ? { fixture: true } : {}) };
}

export function parseArtifactSpec(value: unknown): ArtifactSpec {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArtifactValidationError('invalid_spec', 'artifact spec must be an object');
	const source = value as Record<string, unknown>;
	if (typeof source.kind !== 'string') throw new ArtifactValidationError('invalid_spec', 'artifact kind is required');
	let spec: ArtifactSpec;
	switch (source.kind) {
		case 'chart': spec = chartSpec(source); break;
		case 'table': spec = tableSpec(source); break;
		case 'map': spec = mapSpec(source); break;
		case 'image': spec = { kind: 'image', title: boundedString(source.title, 'title', 200), alt: boundedString(source.alt, 'alt', 400), ...(source.caption === undefined ? {} : { caption: boundedString(source.caption, 'caption', 400) }), ...(source.sources === undefined ? {} : { sources: sources(source.sources) }), ...(source.fixture === true ? { fixture: true } : {}) }; break;
		case 'markdown': {
			const markdown = boundedString(source.markdown, 'markdown', 32_000);
			if (/<\s*(script|style|iframe|object|embed)\b/i.test(markdown) || /javascript:/i.test(markdown)) throw new ArtifactValidationError('invalid_spec', 'markdown contains a disallowed construct');
			spec = { kind: 'markdown', title: boundedString(source.title, 'title', 200), markdown, ...(source.sources === undefined ? {} : { sources: sources(source.sources) }), ...(source.fixture === true ? { fixture: true } : {}) };
			break;
		}
		default: throw new ArtifactValidationError('invalid_spec', 'artifact kind is unsupported');
	}
	if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > ARTIFACT_MAX_SPEC_BYTES) throw new ArtifactValidationError('spec_too_large', 'artifact spec is too large');
	return spec;
}

export function serializeArtifactSpec(spec: ArtifactSpec): { json: string; sha256: string } {
	const json = JSON.stringify(spec);
	if (Buffer.byteLength(json, 'utf8') > ARTIFACT_MAX_SPEC_BYTES) throw new ArtifactValidationError('spec_too_large', 'artifact spec is too large');
	return { json, sha256: createHash('sha256').update(json).digest('hex') };
}

export function artifactSpecFromJson(value: string): ArtifactSpec {
	try {
		return parseArtifactSpec(JSON.parse(value));
	} catch (error) {
		if (error instanceof ArtifactValidationError) throw error;
		throw new ArtifactValidationError('invalid_spec', 'artifact spec is invalid');
	}
}
