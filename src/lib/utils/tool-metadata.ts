import type { PersistedSource, StreamToolCall } from './stream-events';

interface ToolMetadataEnvelope {
	version: 1;
	tools: StreamToolCall[];
	sources: PersistedSource[];
}

export interface AnswerProvenanceBundle {
	version: 1;
	messageId: string;
	conversationId: string;
	createdAt: number;
	tools: StreamToolCall[];
	sources: PersistedSource[];
	stream: {
		startedAt: number;
		endedAt: number;
		elapsedMs: number;
		assistantChars: number;
		done: boolean;
		finishStatus: 'completed' | 'partial' | 'failed' | 'cancelled';
		events: Record<string, number>;
	};
	metadata: {
		transport?: string;
		reasoningEffort?: string;
		model?: string;
		toolCount: number;
		sourceCount: number;
		usedSourceCount: number;
	};
}

export interface BuildAnswerProvenanceInput {
	messageId: string;
	conversationId: string;
	tools: StreamToolCall[];
	sources: PersistedSource[];
	startedAt: number;
	endedAt?: number;
	assistantChars: number;
	done: boolean;
	finishStatus?: AnswerProvenanceBundle['stream']['finishStatus'];
	events?: Record<string, number>;
	transport?: string;
	reasoningEffort?: string;
	model?: string;
}

export interface ParsedToolMetadata {
	tools: StreamToolCall[];
	sources: PersistedSource[];
}

const SENSITIVE_KEY_RE = /authorization|cookie|token|secret|password|credential|api[_-]?key|database[_-]?url|session/i;
const REDACT_TEXT_PATTERNS: Array<[RegExp, string]> = [
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
	[/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]'],
	[/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted-database-url]'],
	[/\b[A-Za-z0-9._%+-]+:[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-credential]']
];
const MAX_PROVENANCE_STRING = 4000;
const MAX_PROVENANCE_ARRAY = 50;
const MAX_PROVENANCE_DEPTH = 6;

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

function sanitizeProvenanceValue(key: string, value: unknown, depth = 0): unknown {
	if (SENSITIVE_KEY_RE.test(key)) return '[redacted]';
	if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
	if (typeof value === 'string') return compactProvenanceString(redactSensitiveText(value));
	if (depth >= MAX_PROVENANCE_DEPTH) return '[truncated]';
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_PROVENANCE_ARRAY)
			.map((item, index) => sanitizeProvenanceValue(`${key}.${index}`, item, depth + 1));
	}
	if (typeof value === 'object') {
		const sanitized: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
			sanitized[childKey] = sanitizeProvenanceValue(childKey, childValue, depth + 1);
		}
		return sanitized;
	}
	return compactProvenanceString(String(value));
}

function redactSensitiveText(value: string): string {
	return REDACT_TEXT_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function compactProvenanceString(value: string): string {
	return value.length > MAX_PROVENANCE_STRING ? `${value.slice(0, MAX_PROVENANCE_STRING)}...` : value;
}

function sanitizeTool(tool: StreamToolCall): StreamToolCall {
	const sanitized: StreamToolCall = {
		id: tool.id,
		name: tool.name,
		status: tool.status,
		startedAt: tool.startedAt,
		endedAt: tool.endedAt,
		durationMs: tool.durationMs,
		transcript: typeof tool.transcript === 'string' ? compactProvenanceString(redactSensitiveText(tool.transcript)) : undefined,
		detail: typeof tool.detail === 'string' ? compactProvenanceString(redactSensitiveText(tool.detail)) : undefined,
		url: tool.url,
		title: tool.title
	};
	if (tool.arguments !== undefined) sanitized.arguments = sanitizeProvenanceValue('arguments', tool.arguments);
	if (tool.result !== undefined) sanitized.result = sanitizeProvenanceValue('result', tool.result);
	return Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined)) as StreamToolCall;
}

function sanitizeSource(source: PersistedSource): PersistedSource {
	return {
		...source,
		title: compactProvenanceString(redactSensitiveText(source.title)),
		detail: source.detail ? compactProvenanceString(redactSensitiveText(source.detail)) : undefined
	};
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
	const stepId = stringValue(o.stepId);
	return {
		id: stringValue(o.id) ?? url,
		url,
		title: stringValue(o.title) ?? url,
		status: stringValue(o.status) ?? 'used',
		domain: stringValue(o.domain) ?? domainOf(url),
		detail: stringValue(o.detail),
		firstSeenAt: numberValue(o.firstSeenAt) ?? numberValue(o.updatedAt) ?? now,
		lastSeenAt: numberValue(o.lastSeenAt) ?? numberValue(o.updatedAt) ?? now,
		used: o.used === true,
		...(stepId ? { stepId } : {})
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

export function buildAnswerProvenanceBundle(input: BuildAnswerProvenanceInput): AnswerProvenanceBundle {
	const merged = mergeToolMetadata(null, input.tools, input.sources);
	const endedAt = input.endedAt ?? Date.now();
	const finishStatus = input.finishStatus ?? (input.done ? 'completed' : 'partial');
	const tools = merged.tools.map(sanitizeTool);
	const sources = merged.sources.map(sanitizeSource);
	return {
		version: 1,
		messageId: input.messageId,
		conversationId: input.conversationId,
		createdAt: endedAt,
		tools,
		sources,
		stream: {
			startedAt: input.startedAt,
			endedAt,
			elapsedMs: Math.max(0, endedAt - input.startedAt),
			assistantChars: input.assistantChars,
			done: input.done,
			finishStatus,
			events: { ...(input.events ?? {}) }
		},
		metadata: {
			transport: input.transport,
			reasoningEffort: input.reasoningEffort,
			model: input.model,
			toolCount: tools.length,
			sourceCount: sources.length,
			usedSourceCount: sources.filter((source) => source.used).length
		}
	};
}

export function serializeAnswerProvenance(input: BuildAnswerProvenanceInput): string {
	return JSON.stringify(buildAnswerProvenanceBundle(input));
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
		const stepId = source.stepId ?? prev?.stepId;
		sourcesByUrl.set(source.url, {
			...prev,
			...source,
			id: prev?.id ?? source.id,
			firstSeenAt: Math.min(prev?.firstSeenAt ?? source.firstSeenAt, source.firstSeenAt),
			lastSeenAt: Math.max(prev?.lastSeenAt ?? source.lastSeenAt, source.lastSeenAt),
			used: Boolean(prev?.used || source.used),
			...(stepId ? { stepId } : {})
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

export function sourceContextForFollowup(raw: string | null | undefined, limit = 6): string {
	const sources = usedSources(parseToolMetadata(raw).sources).slice(0, limit);
	if (!sources.length) return '';
	return [
		'[NewsCraft source context for follow-up questions]',
		'Sources used:',
		...sources.map((source) => {
			const label = compactSourceContextText(source.title || source.url, 140);
			const domain = source.domain || domainOf(source.url);
			const detail = source.detail ? `: ${compactSourceContextText(source.detail, 220)}` : '';
			return `- ${label} (${domain})${detail}`;
		})
	].join('\n');
}

function compactSourceContextText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}
