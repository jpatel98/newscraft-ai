import { readSSE } from '$lib/utils/sse-client';

export interface StreamArgs {
	conversation_id?: string;
	content?: string;
	regenerate?: boolean;
}

export interface StreamCallbacks {
	onDelta: (piece: string) => void;
	onMeta?: (meta: { conversation_id: string }) => void;
	onToolProgress?: (t: { id: string; name: string; emoji?: string }) => void;
	onToolDone?: (id: string) => void;
	onTitle?: (title: string) => void;
	signal?: AbortSignal;
}

interface OpenAIChunk {
	choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
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
				const j = JSON.parse(ev.data) as { id?: string; name?: string; emoji?: string; status?: string };
				const id = String(j.id ?? j.name ?? Math.random());
				const name = String(j.name ?? 'tool');
				if (j.status === 'done' || j.status === 'end' || j.status === 'complete') {
					cb.onToolDone?.(id);
				} else {
					cb.onToolProgress?.({ id, name, emoji: j.emoji });
				}
			} catch {
				/* malformed progress event — skip */
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
