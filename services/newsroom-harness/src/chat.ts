import type {
	GatewayChatCompletionRequest,
	GatewayChatCompletionResponse,
	GatewayChatMessage,
	GatewayContent,
	GatewayContentPart,
	GatewayResponseInputMessage,
	GatewayResponsesRequest
} from '@newscraft/shared';
import {
	SSE_DONE_FRAME,
	chatCompletionDeltaFrame,
	agentCitationsFrame,
	agentPlanFrame,
	agentToolProgressFrame,
	sseFrame
} from './util/sse.js';
import type { ServerResponse } from 'node:http';
import type { NewsroomAgentRuntime, RuntimeProgressEvent } from './agents/runtime.js';
import { cleanVisibleChatOutput } from './agents/answer.js';
import { newId } from './util/ids.js';
import { noStoreSseHeaders } from './util/http.js';
import { promptFromChatMessages } from './util/text.js';

export async function writeChatCompletion(
	res: ServerResponse,
	body: GatewayChatCompletionRequest,
	runtime: NewsroomAgentRuntime,
	signal: AbortSignal,
	traceId?: string
): Promise<void> {
	const id = newId('chatcmpl');
	const model = body.model || 'newsroom-harness';
	const prompt = promptFromChatMessages(body.messages || []);
	if (body.stream) {
		res.writeHead(200, noStoreSseHeaders());
		// Deltas are passed through as they arrive; the runtime owns visible-output
		// sanitization so the first token reaches the user without buffering.
		for await (const delta of runtime.streamChat(body.messages || [], {
			signal,
			runId: traceId,
			model,
			reasoningEffort: body.reasoning_effort,
			plannerEnabled: body.planner_enabled,
			newsroomContext: body.newsroom_context,
			conversationContext: body.conversation_context,
			documents: body.documents,
			onProgress: (event) => writeProgress(res, event)
		})) {
			if (signal.aborted) break;
			if (delta) res.write(chatCompletionDeltaFrame(delta, { id, model }));
		}
		res.write(SSE_DONE_FRAME);
		res.end();
		return;
	}

	const text = cleanVisibleChatOutput(
		await runtime.completeChat(body.messages || [], {
			signal,
			runId: traceId,
			model,
			reasoningEffort: body.reasoning_effort,
			plannerEnabled: body.planner_enabled,
			newsroomContext: body.newsroom_context,
			conversationContext: body.conversation_context,
			documents: body.documents
		}),
		prompt
	);
	const response: GatewayChatCompletionResponse = {
		id,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: text },
				finish_reason: 'stop'
			}
		]
	};
	res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(response));
}

export async function writeResponses(
	res: ServerResponse,
	body: GatewayResponsesRequest,
	runtime: NewsroomAgentRuntime,
	signal: AbortSignal,
	traceId?: string
): Promise<void> {
	const id = newId('resp');
	const model = body.model || 'newsroom-harness';
	const messages = messagesFromResponsesRequest(body);
	const prompt = promptFromChatMessages(messages);

	if (body.stream) {
		res.writeHead(200, noStoreSseHeaders());
		res.write(sseFrame({ event: 'response.created', data: { response: { id, model, status: 'in_progress' } } }));
		let output = '';
		for await (const delta of runtime.streamChat(messages, {
			signal,
			runId: traceId,
			model,
			reasoningEffort: body.reasoning_effort,
			newsroomContext: body.newsroom_context,
			conversationContext: body.conversation_context,
			documents: body.documents,
			onProgress: (event) => writeProgress(res, event)
		})) {
			if (signal.aborted) break;
			if (!delta) continue;
			output += delta;
			res.write(sseFrame({ event: 'response.output_text.delta', data: { delta } }));
		}
		res.write(
			sseFrame({
				event: 'response.completed',
				data: {
					response: {
						id,
						model,
						status: 'completed',
						output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }]
					}
				}
			})
		);
		res.end();
		return;
	}

	const text = cleanVisibleChatOutput(
		await runtime.completeChat(messages, {
			signal,
			runId: traceId,
			model,
			reasoningEffort: body.reasoning_effort,
			newsroomContext: body.newsroom_context,
			conversationContext: body.conversation_context,
			documents: body.documents
		}),
		prompt
	);
	res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(
		JSON.stringify({
			id,
			object: 'response',
			model,
			status: 'completed',
			output_text: text,
			output: [{ type: 'message', content: [{ type: 'output_text', text }] }]
		})
	);
}

function messagesFromResponsesRequest(body: GatewayResponsesRequest): GatewayChatMessage[] {
	const messages: GatewayChatMessage[] = [];
	const instructions = body.instructions?.trim();
	if (instructions) messages.push({ role: 'system', content: instructions });
	if (typeof body.input === 'string') {
		if (body.input.trim()) messages.push({ role: 'user', content: body.input });
		return messages;
	}
	for (const item of body.input || []) {
		const content = responseInputContentToChatContent(item);
		if (!content) continue;
		messages.push({ role: item.role, content });
	}
	return messages;
}

function responseInputContentToChatContent(item: GatewayResponseInputMessage): GatewayContent | null {
	if (typeof item.content === 'string') return item.content;
	const parts: GatewayContentPart[] = [];
	for (const part of item.content) {
		if (part.type === 'input_text' && part.text) {
			parts.push({ type: 'text', text: part.text });
			continue;
		}
		if (part.type === 'input_image' && part.image_url) {
			parts.push({ type: 'image_url', image_url: { url: part.image_url } });
		}
	}
	if (!parts.length) return null;
	return parts;
}

function writeProgress(res: ServerResponse, event: RuntimeProgressEvent): void {
	if (event.type === 'citations') {
		res.write(agentCitationsFrame({ citations: event.citations }));
		return;
	}
	if (event.type === 'plan') {
		res.write(agentPlanFrame({ source: event.planSource, steps: event.steps }));
		return;
	}
	if (event.type === 'tool') {
		res.write(
			agentToolProgressFrame({
				id: event.id,
				name: event.name,
				status: event.status,
				detail: event.detail,
				result: event.result,
				done: event.status === 'ok' || event.status === 'failed'
			})
		);
		return;
	}
	res.write(
		sseFrame({
			event: 'agent.source',
			data: {
				id: event.source.url,
				url: event.source.url,
				title: event.source.title,
				status: event.source.used ? 'used' : 'skipped',
				detail: event.source.summary,
				...(event.stepId ? { stepId: event.stepId } : {})
			}
		})
	);
}
