import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat stream timeout terminal contract', () => {
	it('bounds upstream synthesis and closes with a recoverable partial or persistence terminal', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(source).toContain('linkChatAbort(request.signal, CHAT_STREAM_MAX_MS)');
		expect(source).toContain('createChatIdleWatchdog(upstreamAbort, CHAT_STREAM_IDLE_MS)');
		expect(source).toContain('idleWatchdog.toolStarted(update.tool.id)');
		expect(source).toContain("update.tool.status === 'ok'");
		expect(source).toContain('idleWatchdog.toolFinished(update.tool.id)');
		expect(source).toContain("sseFrame('agent.heartbeat'");
		expect(source).toContain('idleWatchdog.hasActiveTools()');
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
