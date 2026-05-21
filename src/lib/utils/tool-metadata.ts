import type { PersistedSource, StreamToolCall } from './stream-events';

interface ToolMetadataEnvelope {
	version: 1;
	tools: StreamToolCall[];
	sources: PersistedSource[];
}

export interface ParsedToolMetadata {
	tools: StreamToolCall[];
	sources: PersistedSource[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}

function normalizeTool(value: unknown, fallbackId: string): StreamToolCall | null {
	const o = objectValue(value);
	if (!o) return null;
	const id = stringValue(o.id) ?? fallbackId;
	const name = stringValue(o.name) ?? 'tool';
	return {
		id,
		name,
		status: stringValue(o.status) ?? 'unknown',
		startedAt: numberValue(o.startedAt),
		endedAt: numberValue(o.endedAt),
		durationMs: numberValue(o.durationMs),
		arguments: o.arguments,
		result: o.result,
		transcript: stringValue(o.transcript),
		detail: stringValue(o.detail),
		url: stringValue(o.url),
		title: stringValue(o.title)
	};
}

function normalizeSource(value: unknown): PersistedSource | null {
	const o = objectValue(value);
	const url = stringValue(o?.url);
	if (!o || !url || !/^https?:\/\//i.test(url)) return null;
	const now = Date.now();
	return {
		id: stringValue(o.id) ?? url,
		url,
		title: stringValue(o.title) ?? url,
		status: stringValue(o.status) ?? 'used',
		domain: stringValue(o.domain) ?? domainOf(url),
		detail: stringValue(o.detail),
		firstSeenAt: numberValue(o.firstSeenAt) ?? numberValue(o.updatedAt) ?? now,
		lastSeenAt: numberValue(o.lastSeenAt) ?? numberValue(o.updatedAt) ?? now,
		used: o.used === true
	};
}

export function parseToolMetadata(raw: string | null | undefined): ParsedToolMetadata {
	if (!raw) return { tools: [], sources: [] };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return {
				tools: parsed
					.map((tool, i) => normalizeTool(tool, `tool-${i + 1}`))
					.filter((tool): tool is StreamToolCall => Boolean(tool)),
				sources: []
			};
		}

		const envelope = objectValue(parsed);
		if (!envelope || envelope.version !== 1) return { tools: [], sources: [] };
		return {
			tools: Array.isArray(envelope.tools)
				? envelope.tools
						.map((tool, i) => normalizeTool(tool, `tool-${i + 1}`))
						.filter((tool): tool is StreamToolCall => Boolean(tool))
				: [],
			sources: Array.isArray(envelope.sources)
				? envelope.sources
						.map(normalizeSource)
						.filter((source): source is PersistedSource => Boolean(source))
				: []
		};
	} catch {
		return { tools: [], sources: [] };
	}
}

export function serializeToolMetadata(
	tools: StreamToolCall[],
	sources: PersistedSource[]
): string | null {
	if (tools.length === 0 && sources.length === 0) return null;
	return JSON.stringify({ version: 1, tools, sources } satisfies ToolMetadataEnvelope);
}

export function mergeToolMetadata(
	existingRaw: string | null | undefined,
	nextTools: StreamToolCall[],
	nextSources: PersistedSource[]
): ParsedToolMetadata {
	const existing = parseToolMetadata(existingRaw);
	const toolsById = new Map<string, StreamToolCall>();
	for (const tool of existing.tools) toolsById.set(tool.id, tool);
	for (const tool of nextTools) toolsById.set(tool.id, { ...toolsById.get(tool.id), ...tool });

	const sourcesByUrl = new Map<string, PersistedSource>();
	for (const source of existing.sources) sourcesByUrl.set(source.url, source);
	for (const source of nextSources) {
		const prev = sourcesByUrl.get(source.url);
		sourcesByUrl.set(source.url, {
			...prev,
			...source,
			id: prev?.id ?? source.id,
			firstSeenAt: Math.min(prev?.firstSeenAt ?? source.firstSeenAt, source.firstSeenAt),
			lastSeenAt: Math.max(prev?.lastSeenAt ?? source.lastSeenAt, source.lastSeenAt),
			used: Boolean(prev?.used || source.used)
		});
	}

	return {
		tools: Array.from(toolsById.values()),
		sources: Array.from(sourcesByUrl.values())
	};
}

export function usedSources(sources: PersistedSource[]): PersistedSource[] {
	return sources
		.filter((source) => source.used)
		.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
}
