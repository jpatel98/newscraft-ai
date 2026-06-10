import type { GatewayChatCompletionChunk } from './gateway.js';

export interface SseEvent {
	event?: string;
	data: unknown;
	id?: string;
	retry?: number;
}

export const SSE_DONE_FRAME = 'data: [DONE]\n\n';

export function sseFrame(event: SseEvent): string {
	let out = '';
	if (event.id) out += `id: ${event.id}\n`;
	if (event.event && event.event !== 'message') out += `event: ${event.event}\n`;
	if (typeof event.retry === 'number' && Number.isFinite(event.retry)) {
		out += `retry: ${Math.max(0, Math.round(event.retry))}\n`;
	}
	const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
	for (const line of data.split(/\r?\n/)) out += `data: ${line}\n`;
	return `${out}\n`;
}

export function chatCompletionDelta(
	content: string,
	options: { id: string; model: string; created?: number; finishReason?: string | null }
): GatewayChatCompletionChunk {
	return {
		id: options.id,
		object: 'chat.completion.chunk',
		created: options.created ?? Math.floor(Date.now() / 1000),
		model: options.model,
		choices: [
			{
				index: 0,
				delta: content ? { content } : {},
				finish_reason: options.finishReason ?? null
			}
		]
	};
}

export function chatCompletionDeltaFrame(
	content: string,
	options: { id: string; model: string; created?: number }
): string {
	return sseFrame({ data: chatCompletionDelta(content, options) });
}

export function agentToolProgressFrame(data: unknown): string {
	return sseFrame({ event: 'agent.tool.progress', data });
}

export function agentSourceFrame(data: unknown): string {
	return sseFrame({ event: 'agent.source', data });
}

export function agentPlanFrame(data: unknown): string {
	return sseFrame({ event: 'agent.plan', data });
}
