import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat stream timeout terminal contract', () => {
	it('bounds upstream synthesis and closes with a recoverable partial or persistence terminal', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(source).toContain('linkChatAbort(request.signal, CHAT_STREAM_MAX_MS)');
		expect(source).toContain('upstreamAbort.abort(new ChatPhaseTimeoutError');
		expect(source).toContain('streamChatCompletion(');
		expect(source).toContain('signal: upstreamAbort.signal');
		expect(source).toContain('async function emitSafePartialTerminal');
		expect(source).toContain("persistAssistantBounded('partial')");
		expect(source).toContain("sseFrame('agent.answer.partial'");
		expect(source).toContain("'agent.persistence_error'");
		expect(source).toContain("safeEnqueue(controller, 'data: [DONE]\\n\\n')");
		expect(source).toContain('phaseAbort.cleanup()');
	});
});
