import { readSSE } from '$lib/utils/sse-client';
import type { ChatCommand, MessageContent } from '$lib/types';

export interface StreamArgs {
	conversation_id?: string;
	content?: MessageContent;
	regenerate?: boolean;
	resume?: boolean;
	message_id?: string;
	command?: ChatCommand;
}

export interface StreamCallbacks {
	onDelta: (piece: string) => void;
	onMeta?: (meta: { conversation_id: string }) => void;
	onToolProgress?: (t: {
		id: string;
		name: string;
		emoji?: string;
		status?: string;
		detail?: string;
		url?: string;
		title?: string;
	}) => void;
	onToolDone?: (id: string) => void;
	onSource?: (source: {
		id: string;
		url: string;
		title: string;
		status: string;
		domain?: string;
		detail?: string;
	}) => void;
	onTitle?: (title: string) => void;
	signal?: AbortSignal;
}

interface OpenAIChunk {
	choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function domainOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return undefined;
	}
}

function emitSourceFromPayload(payload: Record<string, unknown>, cb: StreamCallbacks): boolean {
	const nested = objectValue(payload.source) ?? objectValue(payload.url) ?? null;
	const source = nested ?? payload;
	const url = stringValue(source.url ?? source.href ?? source.link ?? source.uri);
	if (!url || !/^https?:\/\//i.test(url)) return false;
	const title =
		stringValue(source.title ?? source.name ?? source.label) ||
		stringValue(payload.title ?? payload.name) ||
		url;
	const status = stringValue(source.status ?? payload.status ?? payload.phase) || 'reading';
	const detail =
		stringValue(source.detail ?? source.summary ?? source.snippet ?? payload.detail ?? payload.message) ?? undefined;
	cb.onSource?.({
		id: stringValue(source.id ?? payload.id) || url,
		url,
		title,
		status,
		domain: stringValue(source.domain ?? payload.domain) ?? domainOf(url),
		detail
	});
	return true;
}

export async function streamChat(args: StreamArgs, cb: StreamCallbacks): Promise<void> {
	const r = await fetch('/api/chat/stream', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(args),
		signal: cb.signal
	});
	if (!r.ok) throw new Error(`stream ${r.status}: ${await r.text().catch(() => '')}`);
	if (!r.body) throw new Error('no stream body');

	for await (const ev of readSSE(r.body)) {
		if (ev.event === 'hermes.meta') {
			try {
				cb.onMeta?.(JSON.parse(ev.data) as { conversation_id: string });
			} catch {
				/* ignore */
			}
			continue;
		}
		if (ev.event === 'hermes.tool.progress') {
			try {
				const j = JSON.parse(ev.data) as Record<string, unknown>;
				const id = String(j.id ?? j.name ?? Math.random());
				const name = String(j.name ?? 'tool');
				const status = stringValue(j.status);
				emitSourceFromPayload(j, cb);
				if (status === 'done' || status === 'end' || status === 'complete' || status === 'completed') {
					cb.onToolDone?.(id);
				} else {
					cb.onToolProgress?.({
						id,
						name,
						emoji: stringValue(j.emoji) ?? undefined,
						status: status ?? undefined,
						detail: stringValue(j.detail ?? j.message ?? j.summary) ?? undefined,
						url: stringValue(j.url ?? j.href ?? j.link) ?? undefined,
						title: stringValue(j.title) ?? undefined
					});
				}
			} catch {
				/* malformed progress event — skip */
			}
			continue;
		}
		if (ev.event.startsWith('hermes.source') || ev.event.startsWith('hermes.progress')) {
			try {
				const payload = JSON.parse(ev.data) as Record<string, unknown>;
				if (emitSourceFromPayload(payload, cb)) continue;
				const id = String(payload.id ?? payload.name ?? ev.event);
				cb.onToolProgress?.({
					id,
					name: stringValue(payload.name ?? payload.label ?? ev.event) ?? ev.event,
					status: stringValue(payload.status ?? payload.phase) ?? undefined,
					detail: stringValue(payload.detail ?? payload.message ?? payload.text) ?? undefined
				});
			} catch {
				/* ignore */
			}
			continue;
		}
		if (ev.event === 'hermes.title') {
			try {
				const { title } = JSON.parse(ev.data) as { title: string };
				if (title) cb.onTitle?.(title);
			} catch {
				/* ignore */
			}
			continue;
		}
		if (ev.data === '[DONE]') return;
		try {
			const j = JSON.parse(ev.data) as OpenAIChunk;
			const piece = j.choices?.[0]?.delta?.content ?? '';
			if (piece) cb.onDelta(piece);
		} catch {
			/* ignore malformed frames */
		}
	}
}
