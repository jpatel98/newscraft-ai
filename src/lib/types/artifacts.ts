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
	kind: 'chart'; title: string; subtitle?: string; chartType: 'line' | 'bar' | 'area' | 'scatter'; unit?: string; series: ChartSeries[]; sources?: ArtifactSource[]; fixture?: boolean;
}
export interface TableArtifactSpec {
	kind: 'table'; title: string; columns: Array<{ id: string; label: string; type?: 'text' | 'number' | 'date' }>; rows: Array<Record<string, string | number | null>>; sources?: ArtifactSource[]; fixture?: boolean;
}
export interface ImageArtifactSpec { kind: 'image'; title: string; alt: string; caption?: string; sources?: ArtifactSource[]; fixture?: boolean; }
export interface MarkdownArtifactSpec { kind: 'markdown'; title: string; markdown: string; sources?: ArtifactSource[]; fixture?: boolean; }
export interface MapFeature {
	type: 'Feature'; properties?: { id?: string; label?: string; layer?: string; [key: string]: unknown }; geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: [number, number][] } | { type: 'Polygon'; coordinates: [number, number][][] };
}
export interface MapArtifactSpec { kind: 'map'; title: string; subtitle?: string; features: MapFeature[]; layers?: Array<{ id: string; label: string; visible?: boolean }>; sources?: ArtifactSource[]; fixture?: boolean; }
export type ArtifactSpec = ChartArtifactSpec | TableArtifactSpec | ImageArtifactSpec | MarkdownArtifactSpec | MapArtifactSpec;
export interface ArtifactSummary {
	id: string; revisionId: string; revision: number; kind: ArtifactKind; title: string; status: ArtifactStatus; sourceMessageId: string; createdAt: number; updatedAt: number; fixture?: boolean;
	preview?: { assetId: string; mimeType: string; sizeBytes: number; width?: number | null; height?: number | null } | null;
	error?: { code: string; message: string } | null;
}
export interface ArtifactDetail extends ArtifactSummary {
	spec: ArtifactSpec;
	assets: Array<{ id: string; role: ArtifactAssetRole; mimeType: string; sizeBytes: number; checksumSha256: string; width?: number | null; height?: number | null; objectVersion: string }>;
}
