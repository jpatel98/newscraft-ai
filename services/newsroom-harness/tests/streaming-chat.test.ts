import { describe, expect, it } from 'vitest';
import { cleanVisibleChatOutput } from '../src/agents/answer.js';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { NewsroomAgentRuntime } from '../src/agents/runtime.js';
import { StreamingAnswerSanitizer, streamTailForFinalAnswer } from '../src/agents/stream-sanitizer.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory, type ToolRunOutput } from '../src/agents/tools.js';
import { readOpenAiResponseStream } from '../src/util/openai-stream.js';

function chatSanitizer(prompt = 'What happened at city hall?') {
	return new StreamingAnswerSanitizer({ clean: (raw) => cleanVisibleChatOutput(raw, prompt) });
}

describe('StreamingAnswerSanitizer', () => {
	it('emits cleaned text incrementally at line boundaries', () => {
		const sanitizer = chatSanitizer();
		const first = sanitizer.push('Today\n');
		const second = sanitizer.push('Council vote: The budget passed 5-4.\n');

		expect(first).toBe('Today');
		expect(second).toBe('\nCouncil vote: The budget passed 5-4.');
		expect(sanitizer.emitted).toBe('Today\nCouncil vote: The budget passed 5-4.');
	});

	it('strips markdown and links from streamed lines', () => {
		const sanitizer = chatSanitizer();
		const out = sanitizer.push('**Transit strike**: Buses stopped at [CBC](https://cbc.ca/story) today.\n');

		expect(out).not.toContain('**');
		expect(out).not.toContain('https://');
		expect(out).toContain('Transit strike');
	});

	it('never emits a trailing sources section', () => {
		const sanitizer = chatSanitizer();
		const emitted = [
			sanitizer.push('Story line one is confirmed.\n'),
			sanitizer.push('Sources:\n'),
			sanitizer.push('- [Outlet](https://outlet.com/a)\n')
		].join('');

		expect(emitted).toBe('Story line one is confirmed.');
		expect(sanitizer.emitted).not.toMatch(/sources/i);
	});

	it('flushes long single-line text at sentence boundaries', () => {
		const sanitizer = chatSanitizer();
		const sentenceOne = 'The city confirmed a major water main break downtown that closed two intersections this morning. ';
		const sentenceTwo = 'Crews expect repairs to continue into the evening commute across the core. ';
		const out = sanitizer.push(sentenceOne + sentenceTwo + 'Officials said');

		expect(out).toContain('water main break');
		expect(out).toContain('evening commute');
		expect(out).not.toContain('Officials said');
	});

	it('keeps streamed output consistent with the batch cleaner', () => {
		const raw = [
			'Today',
			'Counterfeit gear bust: Police seized fake jerseys downtown.',
			'Transit delays: A signal failure slowed Line 1 for two hours.',
			'',
			'Latest context',
			'Budget vote: Council passed the budget 5-4 last week.'
		].join('\n');
		const prompt = 'What are the top stories today?';
		const sanitizer = new StreamingAnswerSanitizer({ clean: (value) => cleanVisibleChatOutput(value, prompt) });
		let streamed = '';
		for (let index = 0; index < raw.length; index += 7) {
			streamed += sanitizer.push(raw.slice(index, index + 7));
		}
		const finalAnswer = cleanVisibleChatOutput(raw, prompt);
		const tail = streamTailForFinalAnswer(sanitizer.emitted, finalAnswer);

		expect(tail).not.toBeNull();
		expect(streamed + (tail as string)).toBe(finalAnswer);
	});
});

describe('streamTailForFinalAnswer', () => {
	it('returns the exact remaining suffix when the final answer extends the stream', () => {
		expect(streamTailForFinalAnswer('Story text.', 'Story text.\n\nSome sources were unreadable.')).toBe(
			'\n\nSome sources were unreadable.'
		);
	});

	it('tolerates whitespace differences between streamed and final text', () => {
		expect(streamTailForFinalAnswer('Story  text.', 'Story text.\n\nCaveat here.')).toBe('\n\nCaveat here.');
	});

	it('returns empty when only whitespace remains', () => {
		expect(streamTailForFinalAnswer('Story text.', 'Story text.\n')).toBe('');
	});

	it('returns null when the final answer rewrote the streamed text', () => {
		expect(streamTailForFinalAnswer('Story text.', 'Completely different answer.')).toBeNull();
	});
});

describe('readOpenAiResponseStream', () => {
	function sseBody(frames: string[], chunkSize = 11): ReadableStream<Uint8Array> {
		const text = frames.join('');
		const encoder = new TextEncoder();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (let index = 0; index < text.length; index += chunkSize) {
					controller.enqueue(encoder.encode(text.slice(index, index + chunkSize)));
				}
				controller.close();
			}
		});
	}

	it('forwards text deltas and returns the completed response object', async () => {
		const deltas: string[] = [];
		const result = await readOpenAiResponseStream(
			sseBody([
				`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello ' })}\n\n`,
				`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'world.' })}\n\n`,
				`data: ${JSON.stringify({
					type: 'response.completed',
					response: { output_text: 'Hello world.', usage: { total_tokens: 12 } }
				})}\n\n`,
				'data: [DONE]\n\n'
			]),
			(delta) => deltas.push(delta)
		);

		expect(deltas).toEqual(['Hello ', 'world.']);
		expect(result.status).toBe('completed');
		expect(result.response).toMatchObject({ output_text: 'Hello world.', usage: { total_tokens: 12 } });
	});

	it('reports stream errors and interruptions', async () => {
		const failed = await readOpenAiResponseStream(
			sseBody([`data: ${JSON.stringify({ type: 'error', error: { message: 'rate limited' } })}\n\n`]),
			() => undefined
		);
		const interrupted = await readOpenAiResponseStream(
			sseBody([`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`]),
			() => undefined
		);

		expect(failed.status).toBe('failed');
		expect(failed.error).toBe('rate limited');
		expect(interrupted.status).toBe('interrupted');
		expect(interrupted.response).toBeNull();
	});
});

function usableEvidence(name: string, text: string) {
	return normalizeEvidence({
		source_name: name,
		source_url: `https://example.com/${name}`,
		accessed_at: '2026-06-09T12:00:00.000Z',
		tool_used: name,
		title: `${name} title`,
		published_at: '2026-06-09T09:00:00.000Z',
		extracted_text: text,
		summary: text,
		confidence: 0.7,
		limitations: [],
		source_kind: 'media_report'
	});
}

function streamingStubTool(options: {
	name: string;
	category: ToolCategory;
	deltas: string[];
	answer: string;
	onRun?: (hasDeltaSink: boolean) => void;
	gate?: () => Promise<void>;
}): NewsroomTool {
	return {
		name: options.name,
		description: `${options.name} stub`,
		when_to_use: 'test only',
		category: options.category,
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		async run(_input, context): Promise<ToolRunOutput> {
			options.onRun?.(Boolean(context.onAnswerDelta));
			for (const delta of options.deltas) {
				context.onAnswerDelta?.(delta);
				await options.gate?.();
			}
			return {
				status: 'ok',
				evidence: [usableEvidence(options.name, options.answer)],
				answer: options.answer
			};
		}
	};
}

describe('disciplined agent answer-delta forwarding', () => {
	it('forwards deltas from the answer-producing tool', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['The mayor ', 'is Jane Doe.'],
				answer: 'The mayor is Jane Doe.'
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			config: { enabled_tools: ['openai_web_search'] },
			registry
		});
		const deltas: string[] = [];
		const result = await agent.run('Who is the mayor of Toronto?', {
			outputStyle: 'chat',
			onAnswerDelta: (delta) => deltas.push(delta)
		});

		expect(deltas).toEqual(['The mayor ', 'is Jane Doe.']);
		expect(result.final_answer).toContain('Jane Doe');
	});

	it('does not stream from later tools once an earlier tool produced an answer', async () => {
		const registry = new ToolRegistry();
		let webSearchHadDeltaSink: boolean | null = null;
		registry.register(
			streamingStubTool({
				name: 'configured_source_monitor',
				category: 'source_monitor',
				deltas: ['Official release summary.'],
				answer: 'Official release summary.'
			})
		);
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['Should never stream.'],
				answer: 'Web search answer.',
				onRun: (hasDeltaSink) => {
					webSearchHadDeltaSink = hasDeltaSink;
				}
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			config: { enabled_tools: ['configured_source_monitor', 'openai_web_search'] },
			registry
		});
		const deltas: string[] = [];
		await agent.run('Check the latest Toronto Police releases and summarize anything newsworthy', {
			outputStyle: 'chat',
			onAnswerDelta: (delta) => deltas.push(delta)
		});

		expect(deltas).toEqual(['Official release summary.']);
		expect(webSearchHadDeltaSink).toBe(false);
	});
});

describe('runtime streamed chat', () => {
	it('yields sanitized deltas live, before the agent run finishes', async () => {
		let releaseTool: (() => void) | null = null;
		const gatePassed: boolean[] = [];
		const registry = new ToolRegistry();
		const rawAnswer = 'Water main break: Two intersections are closed downtown.\nTransit delays: Line 1 was slowed by a signal failure.';
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['Water main break: Two intersections are closed downtown.\n', 'Transit delays: Line 1 was slowed by a signal failure.'],
				answer: rawAnswer,
				gate: () =>
					new Promise<void>((resolve) => {
						// Released by the consumer after it receives streamed text, which
						// proves deltas flow before the tool (and run) completes.
						releaseTool = () => {
							gatePassed.push(true);
							resolve();
						};
						setTimeout(() => resolve(), 2000);
					})
			})
		);
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 4,
			runTimeoutMs: 10_000,
			retryLimit: 0,
			openAiApiKey: 'test-key',
			agentConfig: { enabled_tools: ['openai_web_search'], planner_enabled: false },
			registry
		});

		const prompt = 'What happened at city hall this week?';
		const chunks: string[] = [];
		for await (const delta of runtime.streamChat([{ role: 'user', content: prompt }], {})) {
			chunks.push(delta);
			releaseTool?.();
			releaseTool = null;
		}

		expect(gatePassed).toHaveLength(2);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join('')).toBe(cleanVisibleChatOutput(rawAnswer, prompt));
	});

	it('falls back to chunking the final answer when no tool streams', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: [],
				answer: 'A quiet day: Nothing major was reported.'
			})
		);
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 4,
			runTimeoutMs: 10_000,
			retryLimit: 0,
			openAiApiKey: 'test-key',
			agentConfig: { enabled_tools: ['openai_web_search'], planner_enabled: false },
			registry
		});

		const chunks: string[] = [];
		for await (const delta of runtime.streamChat([{ role: 'user', content: 'Latest Mark Carney news' }], {})) {
			chunks.push(delta);
		}

		expect(chunks.join('')).toContain('Nothing major was reported');
	});
});
