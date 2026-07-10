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

export interface DisplaySourceReceipt {
	url: string;
	label: string;
	domain: string;
}

export interface SourceReceiptInput {
	id?: string;
	url?: string;
	title?: string;
	status?: string;
	domain?: string;
	detail?: string;
	firstSeenAt?: number;
	lastSeenAt?: number;
	used?: boolean;
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
const MAX_SOURCE_LABEL = 120;
const SOURCE_LINK_RE = /\[[^\]]*?\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)|<((?:https?:\/\/)[^>\s]+)>|((?:https?:\/\/)[^\s<>)\]]+)/gi;
const SENSITIVE_QUERY_RE = /token|secret|password|credential|session|auth|api[_-]?key|access[_-]?key|signature|sig/i;
const TRACKING_QUERY_RE = /^(utm_|fbclid$|gclid$|mc_[a-z_]+$)/i;
const TECHNICAL_LABEL_RE =
	/(?:^|[_\s-])(?:openai|perplexity|sonar|model|provider|tool|call|adapter|gateway|response|metadata|json|http|fetch|browse|search|url_fetch|web_search)(?:$|[_\s-])/i;
const ID_LIKE_LABEL_RE = /^(?:src|source|tool|call|run|job|msg|message|step)[_-]?[a-z0-9_-]{4,}$/i;

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
	const url = sanitizeSourceUrl(source.url) ?? source.url;
	return {
		...source,
		url,
		title: compactProvenanceString(redactSensitiveText(source.title)),
		domain: domainOf(url),
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

function sanitizeSourceUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		url.username = '';
		url.password = '';
		url.hash = '';
		for (const key of Array.from(url.searchParams.keys())) {
			if (SENSITIVE_QUERY_RE.test(key) || TRACKING_QUERY_RE.test(key)) {
				url.searchParams.delete(key);
			}
		}
		return url.toString();
	} catch {
		return null;
	}
}

function sourceUrlKey(value: string): string | null {
	const sanitized = sanitizeSourceUrl(value);
	if (!sanitized) return null;
	try {
		const url = new URL(sanitized);
		const pathname = url.pathname.replace(/\/$/, '') || '/';
		const search = url.searchParams.toString();
		return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${pathname}${search ? `?${search}` : ''}`;
	} catch {
		return sanitized.toLowerCase();
	}
}

function sourceStatusIsUsed(status: string | undefined): boolean {
	const value = (status || '').toLowerCase();
	if (['queued', 'pending', 'discovered', 'result', 'search_result', 'skipped', 'error'].includes(value)) {
		return false;
	}
	return [
		'open',
		'opened',
		'fetch',
		'fetched',
		'reading',
		'read',
		'used',
		'done',
		'ok',
		'complete',
		'completed',
		'success'
	].includes(value);
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
	const sanitizedUrl = url ? sanitizeSourceUrl(url) : null;
	if (!o || !sanitizedUrl) return null;
	const now = Date.now();
	const stepId = stringValue(o.stepId);
	const status = stringValue(o.status) ?? 'used';
	return {
		id: stringValue(o.id) ?? sanitizedUrl,
		url: sanitizedUrl,
		title: stringValue(o.title) ?? sanitizedUrl,
		status,
		domain: domainOf(sanitizedUrl),
		detail: stringValue(o.detail),
		firstSeenAt: numberValue(o.firstSeenAt) ?? numberValue(o.updatedAt) ?? now,
		lastSeenAt: numberValue(o.lastSeenAt) ?? numberValue(o.updatedAt) ?? now,
		used: o.used === true || (o.used !== false && sourceStatusIsUsed(status)),
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

export function sourceReceiptsForAnswer(
	raw: string | null | undefined,
	answerText: string,
	liveSources: ReadonlyArray<SourceReceiptInput> = []
): DisplaySourceReceipt[] {
	if (!answerText.trim()) return [];
	const linked = linkedUrlKeys(answerText);
	const parsedSources = usedSources(parseToolMetadata(raw).sources);
	const live = liveSources
		.map((source) => normalizeSource(source))
		.filter((source): source is PersistedSource => Boolean(source))
		.filter((source) => source.used);
	const receipts = new Map<string, DisplaySourceReceipt>();

	for (const source of [...parsedSources, ...live]) {
		const key = sourceUrlKey(source.url);
		if (!key || linked.has(key) || receipts.has(key)) continue;
		const url = sanitizeSourceUrl(source.url);
		if (!url) continue;
		receipts.set(key, {
			url,
			label: humanSourceLabel(source),
			domain: domainOf(url)
		});
	}

	return Array.from(receipts.values());
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

function linkedUrlKeys(text: string): Set<string> {
	const keys = new Set<string>();
	for (const match of text.matchAll(SOURCE_LINK_RE)) {
		const raw = match[1] || match[2] || match[3] || '';
		const key = sourceUrlKey(stripTrailingUrlPunctuation(raw));
		if (key) keys.add(key);
	}
	return keys;
}

function stripTrailingUrlPunctuation(value: string): string {
	return value.replace(/[.,;:!?]+$/g, '');
}

function humanSourceLabel(source: PersistedSource): string {
	const title = cleanSourceLabel(source.title);
	if (title && !labelLooksTechnical(title) && !labelLooksLikeUrl(title)) return title;
	const domain = cleanSourceLabel(source.domain) || domainOf(source.url);
	return domain || 'Source';
}

function cleanSourceLabel(value: string | undefined): string {
	if (!value) return '';
	return compactSourceContextText(
		redactSensitiveText(value)
			.replace(/<[^>]*>/g, ' ')
			.replace(/[`*_#[\](){}]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
		MAX_SOURCE_LABEL
	);
}

function labelLooksLikeUrl(value: string): boolean {
	return /^https?:\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function labelLooksTechnical(value: string): boolean {
	const compact = value.trim();
	if (!compact) return true;
	if (ID_LIKE_LABEL_RE.test(compact)) return true;
	if (TECHNICAL_LABEL_RE.test(` ${compact} `)) return true;
	if (/^[{[]/.test(compact)) return true;
	return false;
}
