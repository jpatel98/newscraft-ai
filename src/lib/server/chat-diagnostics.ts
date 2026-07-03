import { listPersistedChatDiagnostics, saveChatDiagnostic } from '$lib/server/db/chat-diagnostics';

export interface ChatDiagnosticEvent {
	id: string;
	conversationId: string;
	type: string;
	createdAt: number;
	details: Record<string, unknown>;
}

const MAX_EVENTS_PER_CONVERSATION = 80;
const MAX_DETAIL_STRING = 500;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_KEY_RE = /authorization|cookie|token|secret|password|key|credential|session|database_url|url$/i;
const REDACT_TEXT_PATTERNS: Array<[RegExp, string]> = [
	[/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
	[/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]'],
	[/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[redacted-database-url]'],
	[/\b[A-Za-z0-9._%+-]+:[^@\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-credential]']
];

const eventsByConversation = new Map<string, ChatDiagnosticEvent[]>();

export function recordChatDiagnostic(
	conversationId: string,
	type: string,
	details: Record<string, unknown> = {}
): void {
	const now = Date.now();
	const event = {
		id: `diag-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		conversationId,
		type,
		createdAt: now,
		details: sanitizeDetails(details)
	};
	const existing = eventsByConversation.get(conversationId) ?? [];
	const next = [...existing.filter((event) => now - event.createdAt <= EVENT_TTL_MS), event].slice(
		-MAX_EVENTS_PER_CONVERSATION
	);
	eventsByConversation.set(conversationId, next);
	void saveChatDiagnostic(event).catch(() => {});
}

export function recentChatDiagnostics(conversationId: string): ChatDiagnosticEvent[] {
	const now = Date.now();
	const events = (eventsByConversation.get(conversationId) ?? []).filter(
		(event) => now - event.createdAt <= EVENT_TTL_MS
	);
	eventsByConversation.set(conversationId, events);
	return events.map((event) => ({
		...event,
		details: { ...event.details }
	}));
}

export async function recentChatDiagnosticsWithPersisted(conversationId: string): Promise<ChatDiagnosticEvent[]> {
	const memoryEvents = recentChatDiagnostics(conversationId);
	let persistedEvents: ChatDiagnosticEvent[] = [];
	try {
		persistedEvents = await listPersistedChatDiagnostics(conversationId);
	} catch {
		return memoryEvents;
	}

	return mergeDiagnosticEvents(persistedEvents, memoryEvents).slice(-MAX_EVENTS_PER_CONVERSATION);
}

export function sanitizeDiagnosticValue(key: string, value: unknown): unknown {
	if (SENSITIVE_KEY_RE.test(key)) return '[redacted]';
	if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
	if (typeof value === 'string') return truncateDetailString(redactSensitiveText(value));
	if (Array.isArray(value)) return value.slice(0, 20).map((item, index) => sanitizeDiagnosticValue(`${key}.${index}`, item));
	if (typeof value === 'object') return sanitizeDetails(value as Record<string, unknown>);
	return String(value);
}

function redactSensitiveText(value: string): string {
	return REDACT_TEXT_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function truncateDetailString(value: string): string {
	return value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}...` : value;
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		sanitized[key] = sanitizeDiagnosticValue(key, value);
	}
	return sanitized;
}

function mergeDiagnosticEvents(...eventGroups: ChatDiagnosticEvent[][]): ChatDiagnosticEvent[] {
	const byId = new Map<string, ChatDiagnosticEvent>();
	for (const event of eventGroups.flat()) {
		byId.set(event.id, {
			...event,
			details: { ...event.details }
		});
	}
	return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
