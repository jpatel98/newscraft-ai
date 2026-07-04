import { readSSE } from '$lib/utils/sse-client';
import {
	StreamEventState,
	type PersistedSource,
	type StreamPlanUpdate,
	type StreamToolUpdate
} from '$lib/utils/stream-events';
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
	onMeta?: (meta: { conversation_id: string; trace_id?: string }) => void;
	onToolProgress?: (t: {
		id: string;
		name: string;
		emoji?: string;
		status?: string;
		detail?: string;
		url?: string;
		title?: string;
		arguments?: unknown;
		result?: unknown;
		transcript?: string;
	}) => void;
	onToolDone?: (id: string, tool?: StreamToolUpdate) => void;
	onSource?: (source: PersistedSource) => void;
	onPlan?: (plan: StreamPlanUpdate) => void;
	onTitle?: (title: string) => void;
	signal?: AbortSignal;
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

	const streamState = new StreamEventState();
	for await (const ev of readSSE(r.body)) {
		if (ev.event === 'agent.meta') {
			try {
				cb.onMeta?.(JSON.parse(ev.data) as { conversation_id: string });
			} catch {
				/* ignore */
			}
			continue;
		}
		for (const update of streamState.apply(ev.event, ev.data)) {
			if (update.title) cb.onTitle?.(update.title);
			if (update.delta) cb.onDelta(update.delta);
			if (update.source) cb.onSource?.(update.source);
			if (update.plan) cb.onPlan?.(update.plan);
			if (update.tool) {
				if (update.tool.done) cb.onToolDone?.(update.tool.id, update.tool);
				else cb.onToolProgress?.(update.tool);
			}
			if (update.failed) throw new Error(update.failed);
		}
	}
}
