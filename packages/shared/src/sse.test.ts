import { describe, expect, it } from 'vitest';
import {
	SSE_DONE_FRAME,
	chatCompletionDeltaFrame,
	agentToolProgressFrame,
	sseFrame
} from './sse.js';

describe('SSE helpers', () => {
	it('formats named events with JSON data', () => {
		expect(sseFrame({ event: 'agent.source', data: { ok: true } })).toBe(
			'event: agent.source\ndata: {"ok":true}\n\n'
		);
	});

	it('splits multi-line string payloads into valid data lines', () => {
		expect(sseFrame({ data: 'alpha\nbeta' })).toBe('data: alpha\ndata: beta\n\n');
	});

	it('builds Chat Completions delta frames compatible with the UI parser', () => {
		const frame = chatCompletionDeltaFrame('Hello', {
			id: 'chatcmpl_test',
			model: 'newsroom-test',
			created: 123
		});
		expect(frame).toContain('"object":"chat.completion.chunk"');
		expect(frame).toContain('"content":"Hello"');
		expect(frame.endsWith('\n\n')).toBe(true);
	});

	it('keeps Agent progress events in their existing event name', () => {
		expect(agentToolProgressFrame({ id: 'tool_1', status: 'running' })).toBe(
			'event: agent.tool.progress\ndata: {"id":"tool_1","status":"running"}\n\n'
		);
	});

	it('exports a canonical done frame', () => {
		expect(SSE_DONE_FRAME).toBe('data: [DONE]\n\n');
	});
});
