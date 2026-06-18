import type {
	GatewayChatCompletionRequest,
	GatewayChatCompletionResponse,
	GatewayResponsesRequest
} from '@newscraft/shared';
import {
	SSE_DONE_FRAME,
	chatCompletionDeltaFrame,
	agentPlanFrame,
	agentToolProgressFrame,
	sseFrame
} from '@newscraft/shared';
import type { ServerResponse } from 'node:http';
import type { NewsroomAgentRuntime, RuntimeProgressEvent } from './agents/runtime.js';
import { cleanVisibleChatOutput } from './agents/answer.js';
import { newId } from './util/ids.js';
import { noStoreSseHeaders } from './util/http.js';
import { promptFromChatMessages, promptFromResponseInput } from './util/text.js';

export async function writeChatCompletion(
	res: ServerResponse,
	body: GatewayChatCompletionRequest,
	runtime: NewsroomAgentRuntime,
	signal: AbortSignal
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
			model,
			reasoningEffort: body.reasoning_effort,
			plannerEnabled: body.planner_enabled,
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
			model,
			reasoningEffort: body.reasoning_effort,
			plannerEnabled: body.planner_enabled
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
	signal: AbortSignal
): Promise<void> {
	const id = newId('resp');
	const model = body.model || 'newsroom-harness';
	const prompt = promptFromResponseInput(body.input || '', body.instructions);
	const messages = [{ role: 'user' as const, content: prompt }];

	if (body.stream) {
		res.writeHead(200, noStoreSseHeaders());
		res.write(sseFrame({ event: 'response.created', data: { response: { id, model, status: 'in_progress' } } }));
		let output = '';
		for await (const delta of runtime.streamChat(messages, {
			signal,
			model,
			reasoningEffort: body.reasoning_effort,
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
			model,
			reasoningEffort: body.reasoning_effort
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

function writeProgress(res: ServerResponse, event: RuntimeProgressEvent): void {
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
