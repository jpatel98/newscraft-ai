import { describe, expect, it } from 'vitest';
import type { ConversationContext, GatewayChatMessage, GatewayResponsesRequest } from '@newscraft/shared';
import type { ServerResponse } from 'node:http';
import { writeResponses } from '../src/chat.js';
import type { NewsroomAgentRuntime, RuntimeContext } from '../src/agents/runtime.js';

describe('responses transport', () => {
	it('preserves structured history, system instructions, and selected-source context', async () => {
		let seenMessages: GatewayChatMessage[] = [];
		let seenContext: RuntimeContext | undefined;
		const conversationContext: ConversationContext = {
			version: 1,
			intent: 'transform',
			sourceMessageId: 'answer-1',
			lastSourceBackedAnswer: {
				messageId: 'answer-1',
				content: 'The TTC update is source-backed [1].',
				citations: [
					{
						citationNumber: 1,
						title: 'TTC update',
						url: 'https://www.ttc.ca/service-advisories?id=123#service',
						domain: 'ttc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'The TTC update is source-backed.'
					}
				]
			}
		};
		const runtime = fakeRuntime({
			completeChat: async (messages, context) => {
				seenMessages = messages;
				seenContext = context;
				return 'ON CAM:\nThe TTC update is source-backed [1].';
			}
		});
		const response = new CaptureResponse();

		await writeResponses(
			response as unknown as ServerResponse,
			{
				input: [
					{ role: 'assistant', content: 'The TTC update is source-backed [1].' },
					{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }
				],
				instructions: 'Use only the selected answer.',
				conversation_context: conversationContext,
				stream: false
			},
			runtime,
			new AbortController().signal,
			'trace-responses-1'
		);

		expect(seenMessages).toEqual([
			{ role: 'system', content: 'Use only the selected answer.' },
			{ role: 'assistant', content: 'The TTC update is source-backed [1].' },
			{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }
		]);
		expect(seenContext?.conversationContext).toBe(conversationContext);
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toMatchObject({
			status: 'completed',
			output_text: 'ON CAM:\nThe TTC update is source-backed [1].'
		});
	});

	it('keeps old string-input Responses clients compatible with separate instructions', async () => {
		let seenMessages: GatewayChatMessage[] = [];
		const runtime = fakeRuntime({
			completeChat: async (messages) => {
				seenMessages = messages;
				return 'NewsCraft ready.';
			}
		});
		const response = new CaptureResponse();

		await writeResponses(
			response as unknown as ServerResponse,
			{
				input: 'Say hi.',
				instructions: 'Be concise.',
				stream: false
			},
			runtime,
			new AbortController().signal
		);

		expect(seenMessages).toEqual([
			{ role: 'system', content: 'Be concise.' },
			{ role: 'user', content: 'Say hi.' }
		]);
		expect(JSON.parse(response.body).output_text).toBe('NewsCraft ready.');
	});
});

function fakeRuntime(overrides: {
	completeChat?: NewsroomAgentRuntime['completeChat'];
	streamChat?: NewsroomAgentRuntime['streamChat'];
}): NewsroomAgentRuntime {
	return {
		completeChat: overrides.completeChat ?? (async () => ''),
		streamChat:
			overrides.streamChat ??
			(async function* () {
				yield '';
			})
	} as unknown as NewsroomAgentRuntime;
}

class CaptureResponse {
	statusCode = 0;
	headers: Record<string, string> = {};
	body = '';

	writeHead(status: number, headers: Record<string, string>) {
		this.statusCode = status;
		this.headers = headers;
	}

	write(chunk: string) {
		this.body += chunk;
	}

	end(chunk?: string) {
		if (chunk) this.body += chunk;
	}
}
