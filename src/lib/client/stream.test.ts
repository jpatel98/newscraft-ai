import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CHAT_STREAM_FAILURE_MESSAGE,
	ChatStreamError,
	subscribeDurableRun,
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

	it('treats a bounded partial-answer terminal event as a completed client turn', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: response.output_text.delta\n' +
						'data: {"delta":"Partial answer."}\n\n' +
						'event: agent.answer.partial\n' +
						'data: {"reason":"bounded_interactive_phase"}\n\n' +
						'data: [DONE]\n\n'
				)
			)
		);
		const onPartial = vi.fn();
		const onDelta = vi.fn();

		await streamChat({ conversation_id: 'convo_1', content: 'Research this.' }, { onDelta, onPartial });

		expect(onDelta).toHaveBeenCalledWith('Partial answer.');
		expect(onPartial).toHaveBeenCalledTimes(1);
	});

	it('surfaces final persistence failure as a retryable stream error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: response.output_text.delta\n' +
						'data: {"delta":"Generated answer."}\n\n' +
						'event: agent.persistence_error\n' +
						'data: {"message":"The answer could not be saved. Retry."}\n\n'
				)
			)
		);

		await expect(
			streamChat({ conversation_id: 'convo_1', content: 'Research this.' }, { onDelta: vi.fn() })
		).rejects.toMatchObject({
			name: 'ChatStreamError',
			diagnosticMessage: 'stream event failed: The answer could not be saved. Retry.'
		});
	});

	it('forwards authoritative answer replacements without appending the draft', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: response.output_text.delta\n' +
						'data: {"delta":"Draft claim."}\n\n' +
						'event: agent.answer.replace\n' +
						'data: {"content":"Authoritative claim [1]."}\n\n' +
						'event: response.completed\n' +
						'data: {"response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Authoritative claim [1]."}]}]}}\n\n' +
						'data: [DONE]\n\n'
				)
			)
		);
		const onDelta = vi.fn();
		const onReplace = vi.fn();

		await streamChat({ conversation_id: 'convo_1', content: 'Research this.' }, { onDelta, onReplace });

		expect(onDelta).toHaveBeenCalledWith('Draft claim.');
		expect(onReplace).toHaveBeenCalledWith('Authoritative claim [1].');
	});

	it('applies replacement events as reducer state instead of concatenating draft deltas', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: response.output_text.delta\n' +
						'data: {"delta":"Claim ."}\n\n' +
						'event: agent.answer.replace\n' +
						'data: {"content":"Claim."}\n\n' +
						'event: response.completed\n' +
						'data: {"response":{"output":[{"type":"message","content":[{"type":"output_text","text":"Claim."}]}]}}\n\n' +
						'data: [DONE]\n\n'
				)
			)
		);
		const rawDeltas: string[] = [];
		let clientText = '';

		await streamChat(
			{ conversation_id: 'convo_1', content: 'Research this.' },
			{
				onDelta(delta) {
					rawDeltas.push(delta);
					clientText += delta;
				},
				onReplace(replacement) {
					clientText = replacement;
				}
			}
		);

		expect(rawDeltas).toEqual(['Claim .']);
		expect(rawDeltas.join('')).not.toBe('Claim.');
		expect(clientText).toBe('Claim.');
	});

	it('keeps a large canonical replacement intact in client reducer state', async () => {
		const canonical = 's'.repeat(262_144);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: response.output_text.delta\n' +
						'data: {"delta":"Draft"}\n\n' +
						'event: agent.answer.replace\n' +
						`data: ${JSON.stringify({ content: canonical })}\n\n` +
						'event: response.completed\n' +
						'data: {"response":{"output":[{"type":"message","content":[{"type":"output_text","text":"completed"}]}]}}\n\n' +
						'data: [DONE]\n\n'
				)
			)
		);
		let clientText = '';
		await streamChat(
			{ conversation_id: 'convo_1', content: 'Research this.' },
			{
				onDelta(delta) {
					clientText += delta;
				},
				onReplace(replacement) {
					clientText = replacement;
				}
			}
		);

		expect(clientText).toBe(canonical);
		expect(clientText.length).toBe(262_144);
	});

	it('rejects a plan-only stream that closes before a completed answer', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: agent.plan\n' +
						'data: {"source":"router","steps":[{"id":"step_1","label":"Checking Japan earthquake updates","status":"running"}]}\n\n'
				)
			)
		);

		await expect(
			streamChat(
				{ conversation_id: 'convo_1', content: "What's the latest on earthquakes in Japan?" },
				{ onDelta: vi.fn(), onPlan: vi.fn() }
			)
		).rejects.toMatchObject({
			name: 'ChatStreamError',
			message: CHAT_STREAM_FAILURE_MESSAGE,
			retryable: true
		});
	});

	it('creates a durable run and ignores replayed events already covered by its snapshot', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: agent.meta\n' +
						'data: {"conversation_id":"convo_1","run_id":"run_1"}\n\n' +
						'event: run.snapshot\n' +
						'data: {"run_id":"run_1","conversation_id":"convo_1","assistant_message_id":"assistant_1","cursor":2,"status":"writing","state":"writing","answerText":"Saved base","sources":[],"citations":[],"tools":[],"errorMessage":null}\n\n' +
						'id: 1\n' +
						'event: response.output_text.delta\n' +
						'data: {"delta":"duplicate"}\n\n' +
						'id: 3\n' +
						'event: response.completed\n' +
						'data: {}\n\n'
				)
			)
		);
		const onSnapshot = vi.fn();
		const onDelta = vi.fn();
		const onRunCursor = vi.fn();
		const onRunState = vi.fn();

		await streamChat({ conversation_id: 'convo_1', content: 'hello', idempotency_key: 'turn-1' }, {
			onRunSnapshot: onSnapshot,
			onDelta,
			onRunCursor
			,onRunState
		});

		expect(vi.mocked(fetch)).toHaveBeenCalledWith(
			'/api/chat/runs',
			expect.objectContaining({ method: 'POST' })
		);
		expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ run_id: 'run_1', answerText: 'Saved base' }));
		expect(onDelta).not.toHaveBeenCalled();
		expect(onRunCursor).toHaveBeenCalledWith(3);
		expect(onRunState).toHaveBeenNthCalledWith(1, 'writing', null);
		expect(onRunState).toHaveBeenLastCalledWith('complete');
	});

	it('reconnects to the same durable run with the saved cursor', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			sseResponse(
				'event: run.snapshot\n' +
					'data: {"run_id":"run_1","conversation_id":"convo_1","assistant_message_id":"assistant_1","cursor":4,"status":"complete","state":"complete","answerText":"Final","sources":[],"citations":[],"tools":[],"errorMessage":null}\n\n'
		)
		);
		vi.stubGlobal('fetch', fetchMock);
		const onSnapshot = vi.fn();

		await subscribeDurableRun('run_1', 3, { onDelta: vi.fn(), onRunSnapshot: onSnapshot });

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/chat/runs/run_1?cursor=3',
			expect.objectContaining({ headers: expect.objectContaining({ 'last-event-id': '3' }) })
		);
		expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ answerText: 'Final', status: 'complete' }));
	});

	it('does not treat a persisted failed run as a successful completion', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse(
					'event: run.snapshot\n' +
						'data: {"run_id":"run_failed","conversation_id":"convo_1","assistant_message_id":"assistant_1","cursor":5,"status":"failed","state":"failed","answerText":"Partial","sources":[],"citations":[],"tools":[],"errorMessage":"Hermes stopped before synthesis"}\n\n'
				)
			)
		);

		await expect(
			subscribeDurableRun('run_failed', 5, { onDelta: vi.fn() })
		).rejects.toMatchObject({
			name: 'ChatStreamError',
			diagnosticMessage: 'durable run failed: Hermes stopped before synthesis'
		});
	});
});
