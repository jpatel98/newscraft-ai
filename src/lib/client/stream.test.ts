import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CHAT_STREAM_FAILURE_MESSAGE,
	ChatStreamError,
	streamChat,
	streamFailureDiagnostic,
	streamFailureMessage
} from './stream';

const enc = new TextEncoder();

function sseResponse(body: string): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(enc.encode(body));
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

describe('streamChat error contract', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('keeps HTTP status and body details out of the public error message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('{"error":"Provider gateway failed at transport.ts:42"}', {
					status: 502,
					statusText: 'Bad Gateway'
				})
			)
		);

		let caught: unknown;
		try {
			await streamChat({ conversation_id: 'convo_1', content: 'What changed?' }, { onDelta: vi.fn() });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ChatStreamError);
		expect(streamFailureMessage(caught)).toBe(CHAT_STREAM_FAILURE_MESSAGE);
		expect(String(caught)).toBe(`ChatStreamError: ${CHAT_STREAM_FAILURE_MESSAGE}`);
		expect(String(caught)).not.toMatch(/502|Bad Gateway|provider|gateway|transport\.ts/i);
		expect(streamFailureDiagnostic(caught)).toContain('stream 502');
		expect(streamFailureDiagnostic(caught)).toContain('Provider gateway failed');
	});

	it('wraps fetch failures without exposing stack-like text publicly', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new Error('Gateway provider stack at openai.ts:12'))
		);

		await expect(
			streamChat({ conversation_id: 'convo_1', content: 'Retry this' }, { onDelta: vi.fn() })
		).rejects.toMatchObject({
			name: 'ChatStreamError',
			message: CHAT_STREAM_FAILURE_MESSAGE,
			publicMessage: CHAT_STREAM_FAILURE_MESSAGE,
			retryable: true
		});
	});

	it('sanitizes failed stream events while preserving diagnostics', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: response.failed\n' +
						'data: {"error":{"message":"OpenAI provider 500 at runtime.ts:77"}}\n\n'
				)
			)
		);

		let caught: unknown;
		try {
			await streamChat({ conversation_id: 'convo_1', content: 'Start stream' }, { onDelta: vi.fn() });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ChatStreamError);
		expect(streamFailureMessage(caught)).toBe(CHAT_STREAM_FAILURE_MESSAGE);
		expect(String(caught)).not.toMatch(/OpenAI|provider|500|runtime\.ts/i);
		expect(streamFailureDiagnostic(caught)).toContain('OpenAI provider 500');
	});

	it('retains successful meta and delta streaming', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: agent.meta\n' +
						'data: {"conversation_id":"convo_1","trace_id":"trace_12345678"}\n\n' +
						'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
						'data: [DONE]\n\n'
				)
			)
		);
		const onMeta = vi.fn();
		const onDelta = vi.fn();

		await streamChat({ conversation_id: 'convo_1', content: 'Say hi' }, { onMeta, onDelta });

		expect(onMeta).toHaveBeenCalledWith({ conversation_id: 'convo_1', trace_id: 'trace_12345678' });
		expect(onDelta).toHaveBeenCalledWith('Hello');
	});
});
