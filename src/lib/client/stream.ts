import { readSSE } from '$lib/utils/sse-client';

interface StreamArgs {
	conversation_id?: string;
	content: string;
}
interface StreamCallbacks {
	onDelta: (piece: string) => void;
	onMeta?: (meta: { conversation_id: string }) => void;
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
			// ephemeral progress strip — no-op for the bare-bones round-trip
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
