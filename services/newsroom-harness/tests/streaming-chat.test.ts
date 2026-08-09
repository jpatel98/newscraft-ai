import { describe, expect, it } from 'vitest';
import { cleanVisibleChatOutput } from '../src/agents/answer.js';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { NewsroomAgentRuntime } from '../src/agents/runtime.js';
import { StreamingAnswerSanitizer, streamTailForFinalAnswer } from '../src/agents/stream-sanitizer.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory, type ToolRunOutput } from '../src/agents/tools.js';
import { readOpenAiResponseStream } from '../src/util/openai-stream.js';
import { splitForStreaming } from '../src/util/text.js';

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

	it('rejects ordinary-word clipped citations while preserving later uncited content', () => {
		const sanitizer = chatSanitizer('Research the story.');
		const streamed = sanitizer.push('- Toronto’s Salsa on [1]\n- Later uncited context.\n');

		expect(streamed).not.toContain('Toronto’s Salsa on');
		expect(streamed).toContain('- Later uncited context.');
		expect(streamTailForFinalAnswer(sanitizer.emitted, '- Toronto’s Salsa on St. Clair [1]\n- Later uncited context.')).toBeNull();
	});

	it('does not leak or duplicate content when a citation line precedes uncited content', () => {
		const sanitizer = new StreamingAnswerSanitizer({
			clean: (value) => cleanVisibleChatOutput(value, 'Research the story.')
		});
		const streamed = [
			sanitizer.push('Intro context.\n- Confirmed claim [1]\n'),
			sanitizer.push('- Later uncited context.\n')
		].join('');
		const finalAnswer = 'Intro context.\n- Confirmed claim [1]\n- Later uncited context.';
		const tail = streamTailForFinalAnswer(sanitizer.emitted, finalAnswer);

		expect(streamed).toBe('Intro context.\n- Later uncited context.');
		expect(streamed).not.toContain('Confirmed claim');
		expect(tail).toBeNull();
	});

	it('rejects labeled Markdown clipped citations while final reconciliation remains authoritative', () => {
		const sanitizer = new StreamingAnswerSanitizer({
			clean: (value) => cleanVisibleChatOutput(value, 'Research the story.')
		});
		const streamed = [
			sanitizer.push('Intro context.\n- **Community event**: Toronto’s Salsa on [1]\n'),
			sanitizer.push('- Later uncited context.\n')
		].join('');
		const finalAnswer = 'Intro context.\n- **Community event**: Toronto’s Salsa on Queen Street [1]\n- Later uncited context.';
		const tail = streamTailForFinalAnswer(sanitizer.emitted, finalAnswer);

		expect(streamed).toBe('Intro context.\n- Later uncited context.');
		expect(streamed).not.toContain('Toronto’s Salsa on');
		expect(streamed).toContain('Later uncited context.');
		expect(tail).toBeNull();
	});

	it('does not lose a marker when streamed chunks split inside it', () => {
		// This isolates chunk framing. The runtime's default policy rejects the
		// cited line until the authoritative final answer is available.
		const sanitizer = new StreamingAnswerSanitizer({
			clean: (value) => cleanVisibleChatOutput(value, 'Research the story.'),
			rejectUnverifiedCitationLines: false
		});
		const emitted = [
			sanitizer.push('Confirmed claim ['),
			sanitizer.push('1'),
			sanitizer.push('] remains complete.\n')
		].join('');

		expect(emitted).toBe('Confirmed claim [1] remains complete.');
	});

	it('keeps a complete structural citation out of the draft and restores it once final evidence is authoritative', () => {
		const sanitizer = chatSanitizer('Research the story.');
		const streamed = sanitizer.push('| Status | Active [1] |\n- Later context.\n');
		const finalAnswer = '| Status | Active [1] |\n- Later context.';

		expect(streamed).toContain('Later context.');
		expect(streamed).not.toContain('Status');
		expect(streamTailForFinalAnswer(sanitizer.emitted, finalAnswer)).toBeNull();
	});

	it('buffers citation markers when completed answers are chunked', () => {
		const chunks = splitForStreaming('A confirmed statement with a citation [123] and more text.', 28);

		expect(chunks.join('')).toBe('A confirmed statement with a citation [123] and more text.');
		expect(chunks.some((chunk) => /\[[^\]]*$/.test(chunk))).toBe(false);
	});

	it('fails closed around a malformed newline inside a citation marker', () => {
		const sanitizer = new StreamingAnswerSanitizer({
			clean: (value) => cleanVisibleChatOutput(value, 'Research the story.')
		});

		const first = sanitizer.push('Context before the malformed marker.\n- Claim [1\n');
		const second = sanitizer.push('] should not stream.\n- Later uncited context.\n');

		expect(first).toBe('Context before the malformed marker.');
		expect(second).toBe('');
		expect(sanitizer.emitted).toBe('Context before the malformed marker.');
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

	it('preserves streamed output-item source metadata for web-search evidence extraction', async () => {
		const deltas: string[] = [];
		const result = await readOpenAiResponseStream(
			sseBody([
				`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Sourced answer.' })}\n\n`,
				`data: ${JSON.stringify({
					type: 'response.output_item.done',
					item: {
						id: 'ws_1',
						type: 'web_search_call',
						action: {
							sources: [
								{
									url: 'https://www.cbc.ca/news/politics/example',
									title: 'CBC example source'
								}
							]
						}
					}
				})}\n\n`,
				`data: ${JSON.stringify({
					type: 'response.completed',
					response: { output_text: 'Sourced answer.', usage: { total_tokens: 18 } }
				})}\n\n`,
				'data: [DONE]\n\n'
			]),
			(delta) => deltas.push(delta)
		);

		expect(deltas).toEqual(['Sourced answer.']);
		expect(result.status).toBe('completed');
		expect(result.response).toMatchObject({
			output_text: 'Sourced answer.',
			output: [
				{
					type: 'web_search_call',
					action: {
						sources: [
							{
								url: 'https://www.cbc.ca/news/politics/example',
								title: 'CBC example source'
							}
						]
					}
				}
			]
		});
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
		published_at: new Date().toISOString(),
		extracted_text: text,
		summary: text,
		confidence: 0.7,
		limitations: [],
		source_kind: 'media_report',
		direct_verified: true
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
	it('does not stream provider-authored sourced prose before validation', async () => {
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

		expect(deltas).toEqual([]);
		expect(result.final_answer).toContain('Jane Doe. [1]');
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

		expect(deltas).toEqual([]);
		expect(webSearchHadDeltaSink).toBe(false);
	});
});

describe('runtime streamed chat', () => {
	it('buffers provider deltas and yields one authoritative structured answer', async () => {
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
		expect(chunks.length).toBeGreaterThan(0);
		const streamed = chunks.join('');
		expect(streamed).toMatch(
			/^\*\*Current as of:\*\* [^\n]+\n\nWater main break: Two intersections are closed downtown\. \[1\]$/
		);
		expect(streamed).not.toContain('Transit delays');
	});

	it('falls back to chunking the final answer when no tool streams', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: [],
				answer: 'Mark Carney: Nothing major was reported in the latest readable update today.'
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

	it('buffers current source-only conversation context until the cited answer is authoritative', async () => {
		let hadDeltaSink: boolean | null = null;
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['City hall budget update: ', 'Council passed the motion.'],
				answer: 'City hall budget update: Council passed the motion.',
				onRun: (value) => {
					hadDeltaSink = value;
				}
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
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'What happened at city hall this week?' }],
			{
				conversationContext: {
					version: 1,
					intent: 'research',
					activeTopic: { subject: 'city hall budget update' }
				}
			}
		)) {
			chunks.push(delta);
		}

		expect(hadDeltaSink).toBe(false);
		expect(chunks.join('')).toContain('Council passed the motion');
	});

	it('does not append an authoritative cited rewrite after already streaming its uncited draft', async () => {
		let hadDeltaSink: boolean | null = null;
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['Council approved the motion.'],
				answer: 'Council approved the motion [1].',
				onRun: (value) => {
					hadDeltaSink = value;
				}
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

		let answer = '';
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'What is the latest confirmed city hall vote today?' }],
			{}
		)) {
			answer += delta;
		}

		expect(hadDeltaSink).toBe(false);
		expect(answer.match(/Council approved the motion/g)).toHaveLength(1);
		expect(answer).toContain('Council approved the motion. [1]');
		expect(answer.match(/Current as of/g)).toHaveLength(1);
	});

	it('buffers direct streamChat callers without onProgress to one final authority', async () => {
		let hadDeltaSink: boolean | null = null;
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['Draft wording that must not escape.'],
				answer: 'Authoritative city hall budget update.',
				onRun: (value) => {
					hadDeltaSink = value;
				}
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

		let answer = '';
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'Research the city hall budget update.' }],
			{}
		)) {
			answer += delta;
		}

		expect(hadDeltaSink).toBe(false);
		expect(answer).toBe('Authoritative city hall budget update. [1]');
		expect(answer).not.toContain('Draft wording');
	});

	it('emits one authoritative replacement when a streamed draft cannot be reconciled', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['Draft wording without the verified citation.\n'],
				answer: 'City hall budget update: Council passed the motion.'
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
		const progress: Array<{ type: string; content?: string }> = [];
		let streamed = '';

		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'What happened at city hall?' }],
			{ onProgress: (event) => progress.push(event as { type: string; content?: string }) }
		)) {
			streamed += delta;
		}

		const replacement = progress.find((event) => event.type === 'answer_replace')?.content;
		expect(streamed).toBe('');
		expect(replacement).toBe('City hall budget update: Council passed the motion. [1]');
		expect(replacement).not.toContain('Draft wording');
		// The transport reducer persists the replacement, not draft + replacement.
		expect(replacement).toBe('City hall budget update: Council passed the motion. [1]');
	});

	it('rejects a clipped cited draft and replaces it with the complete evidence-backed answer', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
					deltas: ['- Toronto’s Salsa on [1]\n'],
					answer: 'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.'
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
		const progress: Array<{ type: string; content?: string }> = [];
		let streamed = '';

		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'Research the community event.' }],
			{ onProgress: (event) => progress.push(event as { type: string; content?: string }) }
		)) {
			streamed += delta;
		}

		const replacement = progress.find((event) => event.type === 'answer_replace')?.content;
		expect(streamed).not.toContain('Toronto’s Salsa on [1]');
		expect(streamed).toBe('');
		expect(replacement).toContain('Toronto’s Salsa on St. Clair');
		expect(replacement).toContain('[1]');
	});

	it('finishes a buffered current response with safe wording when research times out', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: [''],
				answer: 'This answer should never arrive.',
				gate: () => new Promise((resolve) => setTimeout(resolve, 80))
			})
		);
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 4,
			runTimeoutMs: 10,
			retryLimit: 0,
			openAiApiKey: 'test-key',
			agentConfig: { enabled_tools: ['openai_web_search'], planner_enabled: false },
			registry
		});

		let answer = '';
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'What is the latest confirmed city hall vote today?' }],
			{}
		)) {
			answer += delta;
		}

		expect(answer).toContain('Current as of');
		expect(answer).toMatch(
			/(?:Live research could not finish|I couldn't verify this from readable sources) right now\./
		);
		expect(answer).not.toContain('This answer should never arrive');
	});

	it('terminates when discovery completes but the next synthesis decision hangs', async () => {
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: [],
				answer: 'A verified Toronto development was reported today.'
			})
		);
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 4,
			runTimeoutMs: 50,
			retryLimit: 0,
			modelProvider: 'openai',
			openAiApiKey: 'live-key',
			agentConfig: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			loopDecision: () => new Promise(() => {}),
			registry
		});

		let answer = '';
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'What are the latest developing stories in Toronto?' }],
			{}
		)) {
			answer += delta;
		}
		expect(answer).toContain('Current as of');
		expect(answer).toMatch(
			/(?:Live research could not finish|I couldn't verify this from readable sources) right now\./
		);
	});

	it('buffers streaming when the conversation guard may reject constrained evidence', async () => {
		let hadDeltaSink: boolean | null = null;
		const registry = new ToolRegistry();
		registry.register(
			streamingStubTool({
				name: 'openai_web_search',
				category: 'web_search_provider',
				deltas: ['Toronto update should wait.'],
				answer: 'Toronto city hall update: Council passed the motion.',
				onRun: (value) => {
					hadDeltaSink = value;
				}
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
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'What happened at city hall this week?' }],
			{
				conversationContext: {
					version: 1,
					intent: 'research',
					activeTopic: { subject: 'Toronto city hall update', location: 'Toronto' }
				}
			}
		)) {
			chunks.push(delta);
		}

		expect(hadDeltaSink).toBe(false);
		expect(chunks.join('')).toContain('Toronto city hall update');
	});
});
