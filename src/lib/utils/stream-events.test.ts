import { describe, expect, it } from 'vitest';
import {
	sanitizeCitationEventData,
	sanitizeUnresolvedCitationMarkers,
	StreamingCitationSanitizer,
	StreamEventState,
	sseFrame
} from './stream-events';
import type { CitationRecord } from '@newscraft/shared';

describe('StreamEventState', () => {
	it('extracts Chat Completions deltas and Agent tool progress', () => {
		const state = new StreamEventState();

		expect(
			state.apply('message', JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }), 1000)
		).toEqual([{ delta: 'Hello' }]);

		const started = state.apply(
			'agent.tool.progress',
			JSON.stringify({
				id: 'search-1',
				name: 'web_search',
				status: 'start',
				url: 'https://example.com/story',
				title: 'Story',
				verified: true,
				temporalScope: 'primary'
			}),
			1100
		);

		expect(started).toMatchObject([
			{
				source: {
					id: 'search-1',
					url: 'https://example.com/story',
					title: 'Story',
					status: 'start',
					domain: 'example.com'
				}
			},
			{
				tool: {
					id: 'search-1',
					name: 'web_search',
					status: 'running',
					url: 'https://example.com/story',
					done: false
				}
			}
		]);

		const finished = state.apply(
			'agent.tool.progress',
			JSON.stringify({ id: 'search-1', name: 'web_search', status: 'done', result: { count: 2 } }),
			1500
		);

		expect(finished).toMatchObject([
			{
				tool: {
					id: 'search-1',
					name: 'web_search',
					status: 'ok',
					result: { count: 2 },
					done: true
				}
			}
		]);
		expect(state.toolCalls()).toMatchObject([
			{
				id: 'search-1',
				name: 'web_search',
				startedAt: 1100,
				endedAt: 1500,
				result: { count: 2 }
			}
		]);
	});

	it('dedupes sources and marks opened sources as used', () => {
		const state = new StreamEventState();

		state.apply(
			'agent.source',
			JSON.stringify({
				id: 'result-1',
				url: 'https://example.com/story',
				title: 'Story',
				status: 'queued',
				verified: true,
				currentVerified: true,
				temporalScope: 'primary',
				publishedAt: '2026-08-08T12:00:00.000Z'
			}),
			1000
		);
		const opened = state.apply(
			'agent.tool.progress',
			JSON.stringify({
				tool: 'browser_navigate',
				url: 'https://example.com/story',
				title: 'Story',
				status: 'start',
				verified: true,
				currentVerified: true,
				temporalScope: 'primary',
				publishedAt: '2026-08-08T12:00:00.000Z'
			}),
			1200
		);

		expect(opened[0]).toMatchObject({
			source: {
				url: 'https://example.com/story',
				firstSeenAt: 1000,
				lastSeenAt: 1200,
				used: true
			}
		});
		expect(state.sourceList()).toMatchObject([
			{
				url: 'https://example.com/story',
				title: 'Story',
				domain: 'example.com',
				firstSeenAt: 1000,
				lastSeenAt: 1200,
				used: true
			}
		]);
	});

	it('preserves sanitized single-provider research diagnostics for durable provenance', () => {
		const state = new StreamEventState();
		state.apply(
			'agent.tool.progress',
			JSON.stringify({
				id: 'search-1',
				name: 'openai_web_search',
				status: 'running'
			}),
			1000
		);
		state.apply(
			'agent.tool.progress',
			JSON.stringify({
				id: 'search-1',
				name: 'openai_web_search',
				status: 'ok',
				result: {
					count: 1,
						research: {
						attempts: [
							{
								role: 'primary',
								provider: 'openai',
								status: 'failed',
								latencyMs: 22000,
								sourceCount: 0,
								upstreamStatus: 503,
								failureCategory: 'http_5xx'
							},
							{
								role: 'retry',
								provider: 'openai',
								status: 'failed',
								latencyMs: 5000,
								sourceCount: 0
							}
						],
						finalOutcome: 'failed'
					}
				}
			}),
			28000
		);

		expect(state.toolCalls()[0]?.result).toMatchObject({
			count: 1,
			research: {
				finalOutcome: 'failed',
				attempts: [
					{ provider: 'openai', failureCategory: 'http_5xx' },
					{ provider: 'openai', status: 'failed', sourceCount: 0 }
				]
			}
		});
	});

	it('does not mark search-result-only sources as used', () => {
		const state = new StreamEventState();

		const discovered = state.apply(
			'agent.source',
			JSON.stringify({
				url: 'https://example.com/search-result',
				title: 'Search result',
				status: 'start',
				verified: true,
				temporalScope: 'primary'
			}),
			1000
		);

		expect(discovered).toMatchObject([
			{
				source: {
					url: 'https://example.com/search-result',
					used: false
				}
			}
		]);
		expect(state.sourceList()).toMatchObject([
			{
				url: 'https://example.com/search-result',
				used: false
			}
		]);
	});

	it('does not turn raw tool URLs or unverified source events into source progress', () => {
		const state = new StreamEventState();

		expect(
			state.apply(
				'agent.source',
				JSON.stringify({ url: 'https://example.com/raw-search-hit', title: 'Raw hit', status: 'reading' }),
				1000
			)
		).toEqual([
			expect.objectContaining({ tool: expect.objectContaining({ url: 'https://example.com/raw-search-hit' }) })
		]);
		expect(
			state.apply(
				'agent.tool.progress',
				JSON.stringify({ tool: 'browser_navigate', url: 'https://example.com/raw-tool-url', status: 'start' }),
				1100
			)
		).toEqual([
			expect.objectContaining({ tool: expect.objectContaining({ url: 'https://example.com/raw-tool-url' }) })
		]);
		state.apply(
			'agent.source',
			JSON.stringify({
				url: 'https://example.com/unknown-date',
				title: 'Unknown date',
				status: 'used',
				verified: true,
				currentVerified: true,
				temporalScope: 'primary'
			}),
			1200
		);
		expect(state.sourceList()).toEqual([]);
	});

	it('preserves Agent progress labels and previews across tool updates', () => {
		const state = new StreamEventState();

		const started = state.apply(
			'agent.tool.progress',
			JSON.stringify({
				tool: 'delegate_task',
				label: 'Compare current coverage',
				preview: 'worker started',
				status: 'start'
			}),
			1000
		);

		expect(started).toMatchObject([
			{
				tool: {
					id: 'delegate_task-1',
					name: 'delegate_task',
					status: 'running',
					title: 'Compare current coverage',
					detail: 'Compare current coverage',
					transcript: 'worker started',
					done: false
				}
			}
		]);

		expect(
			state.apply(
				'agent.tool.progress',
				JSON.stringify({ tool: 'delegate_task', status: 'progress' }),
				1200
			)
		).toMatchObject([
			{
				tool: {
					id: 'delegate_task-1',
					name: 'delegate_task',
					status: 'running',
					title: 'Compare current coverage',
					detail: 'Compare current coverage',
					transcript: 'worker started',
					done: false
				}
			}
		]);

		expect(
			state.apply(
				'agent.tool.progress',
				JSON.stringify({ tool: 'delegate_task', status: 'done', result: { ok: true } }),
				1500
			)
		).toMatchObject([
			{
				tool: {
					id: 'delegate_task-1',
					name: 'delegate_task',
					status: 'ok',
					title: 'Compare current coverage',
					detail: 'Compare current coverage',
					transcript: 'worker started',
					result: { ok: true },
					done: true
				}
			}
		]);

		expect(state.toolCalls()).toMatchObject([
			{
				id: 'delegate_task-1',
				name: 'delegate_task',
				startedAt: 1000,
				endedAt: 1500,
				title: 'Compare current coverage',
				detail: 'Compare current coverage',
				transcript: 'worker started'
			}
		]);
		expect(state.toolCalls()).toHaveLength(1);
	});

	it('creates separate anonymous Agent tool steps when the target changes', () => {
		const state = new StreamEventState();

		const first = state.apply(
			'agent.tool.progress',
			JSON.stringify({
				tool: 'browser_navigate',
				label: 'https://example.com/first',
				url: 'https://example.com/first',
				verified: true,
				currentVerified: true,
				temporalScope: 'primary',
				publishedAt: '2026-08-08T12:00:00.000Z'
			}),
			1000
		);
		expect(first).toMatchObject([
			{ source: { url: 'https://example.com/first' } },
			{
				tool: {
					id: 'browser_navigate-1',
					name: 'browser_navigate',
					url: 'https://example.com/first',
					done: false
				}
			}
		]);

		const second = state.apply(
			'agent.tool.progress',
			JSON.stringify({
				tool: 'browser_navigate',
				label: 'https://example.com/second',
				url: 'https://example.com/second',
				verified: true,
				currentVerified: true,
				temporalScope: 'primary',
				publishedAt: '2026-08-08T12:00:00.000Z'
			}),
			2000
		);
		expect(second).toMatchObject([
			{ source: { url: 'https://example.com/second' } },
			{
				tool: {
					id: 'browser_navigate-1',
					name: 'browser_navigate',
					status: 'ok',
					done: true,
					endedAt: 2000
				}
			},
			{
				tool: {
					id: 'browser_navigate-2',
					name: 'browser_navigate',
					url: 'https://example.com/second',
					done: false
				}
			}
		]);

		expect(
			state.apply(
				'agent.tool.progress',
				JSON.stringify({ tool: 'browser_navigate', status: 'done' }),
				2500
			)
		).toMatchObject([
			{
				tool: {
					id: 'browser_navigate-2',
					name: 'browser_navigate',
					status: 'ok',
					done: true,
					endedAt: 2500
				}
			}
		]);

		expect(state.toolCalls()).toMatchObject([
			{
				id: 'browser_navigate-1',
				url: 'https://example.com/first',
				startedAt: 1000,
				endedAt: 2000
			},
			{
				id: 'browser_navigate-2',
				url: 'https://example.com/second',
				startedAt: 2000,
				endedAt: 2500
			}
		]);
	});

	it('extracts Responses API text deltas and function call outputs', () => {
		const state = new StreamEventState();

		expect(
			state.apply(
				'response.output_item.added',
				JSON.stringify({
					item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'terminal' }
				}),
				2000
			)
		).toMatchObject([
			{ tool: { id: 'call_1', name: 'terminal', status: 'running', done: false } }
		]);

		expect(
			state.apply(
				'response.function_call_arguments.delta',
				JSON.stringify({ item_id: 'fc_1', delta: '{"command":"ls"}' }),
				2100
			)
		).toMatchObject([
			{ tool: { id: 'call_1', name: 'terminal', arguments: { command: 'ls' } } }
		]);

		expect(
			state.apply(
				'response.output_item.done',
				JSON.stringify({
					item: {
						type: 'function_call_output',
						call_id: 'call_1',
						output: 'README.md\nsrc\n'
					}
				}),
				2600
			)
		).toMatchObject([
			{
				tool: {
					id: 'call_1',
					name: 'terminal',
					status: 'ok',
					result: 'README.md\nsrc\n',
					done: true
				}
			}
		]);

		expect(
			state.apply('response.output_text.delta', JSON.stringify({ delta: 'Done.' }), 2700)
		).toEqual([{ delta: 'Done.' }]);
		expect(state.toolCalls()).toMatchObject([
			{
				id: 'call_1',
				name: 'terminal',
				arguments: { command: 'ls' },
				result: 'README.md\nsrc\n',
				startedAt: 2000,
				endedAt: 2600
			}
		]);
	});

	it('applies an authoritative answer replacement without replaying the draft', () => {
		const state = new StreamEventState();

		expect(
			state.apply('response.output_text.delta', JSON.stringify({ delta: 'Draft claim.' }))
		).toEqual([{ delta: 'Draft claim.' }]);
		expect(
			state.apply('agent.answer.replace', JSON.stringify({ content: 'Authoritative claim [1].' }))
		).toEqual([{ replace: 'Authoritative claim [1].' }]);
		expect(
			state.apply('response.output_text.delta', JSON.stringify({ delta: ' Tail after replacement.' }))
		).toEqual([{ delta: ' Tail after replacement.' }]);
		// A later completed event must not emit the replacement a second time.
		expect(
			state.apply(
				'response.completed',
				JSON.stringify({ response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Authoritative claim [1].' }] }] } })
			)
		).toEqual([{ done: true }]);
	});

	it('keeps fragmented Responses API function arguments on the original call id', () => {
		const state = new StreamEventState();

		state.apply(
			'response.output_item.added',
			JSON.stringify({
				item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'web_search' }
			}),
			1000
		);

		expect(
			state.apply(
				'response.function_call_arguments.delta',
				JSON.stringify({ item_id: 'item_1', delta: '{"query":"release' }),
				1100
			)
		).toMatchObject([
			{ tool: { id: 'call_1', name: 'web_search', arguments: '{"query":"release' } }
		]);

		expect(
			state.apply(
				'response.function_call_arguments.delta',
				JSON.stringify({ item_id: 'item_1', delta: ' notes"}' }),
				1200
			)
		).toMatchObject([
			{ tool: { id: 'call_1', name: 'web_search', arguments: { query: 'release notes' } } }
		]);

		expect(state.toolCalls()).toMatchObject([
			{
				id: 'call_1',
				name: 'web_search',
				startedAt: 1000,
				arguments: { query: 'release notes' }
			}
		]);
	});

	it('parses JSON string tool outputs before they are persisted', () => {
		const state = new StreamEventState();

		state.apply(
			'response.output_item.added',
			JSON.stringify({
				item: { id: 'item_2', type: 'function_call', call_id: 'call_2', name: 'lookup' }
			}),
			2000
		);

		expect(
			state.apply(
				'response.completed',
				JSON.stringify({
					response: {
						output: [
							{
								type: 'function_call_output',
								call_id: 'call_2',
								output: '{"ok":true,"count":2}'
							}
						]
					}
				}),
				2500
			)
		).toMatchObject([
			{
				tool: {
					id: 'call_2',
					name: 'lookup',
					status: 'ok',
					result: { ok: true, count: 2 },
					done: true
				}
			},
			{ done: true }
		]);

		expect(state.toolCalls()).toMatchObject([
			{
				id: 'call_2',
				name: 'lookup',
				result: { ok: true, count: 2 },
				endedAt: 2500
			}
		]);
	});

	it('preserves failed function calls even when no output item follows', () => {
		const state = new StreamEventState();

		expect(
			state.apply(
				'response.output_item.done',
				JSON.stringify({
					item: {
						id: 'item_failed',
						type: 'function_call',
						call_id: 'call_failed',
						name: 'web_search',
						status: 'failed',
						arguments: '{"query":"broken"}'
					}
				}),
				3000
			)
		).toMatchObject([
			{
				tool: {
					id: 'call_failed',
					name: 'web_search',
					status: 'failed',
					arguments: { query: 'broken' },
					done: true
				}
			}
		]);

		expect(state.toolCalls()).toMatchObject([
			{
				id: 'call_failed',
				name: 'web_search',
				status: 'failed',
				startedAt: 3000,
				endedAt: 3000
			}
		]);
	});

	it('falls back to completed response text when no text deltas were seen', () => {
		const state = new StreamEventState();

		expect(
			state.apply(
				'response.completed',
				JSON.stringify({
					response: {
						output: [
							{
								type: 'message',
								content: [{ type: 'output_text', text: 'Final answer.' }]
							}
						]
					}
				})
			)
		).toEqual([{ delta: 'Final answer.' }, { done: true }]);
	});

	it('does not duplicate completed response text after streamed text deltas', () => {
		const state = new StreamEventState();

		expect(
			state.apply('response.output_text.delta', JSON.stringify({ delta: 'Final answer.' }))
		).toEqual([{ delta: 'Final answer.' }]);
		expect(
			state.apply(
				'response.completed',
				JSON.stringify({
					response: {
						output: [
							{
								type: 'message',
								content: [{ type: 'output_text', text: 'Final answer.' }]
							}
						]
					}
				})
			)
		).toEqual([{ done: true }]);
	});

	it('collects ordered structured citation events without truncation', () => {
		const state = new StreamEventState();
		const citations = Array.from({ length: 10 }, (_, index) => ({
			citationNumber: index + 1,
			title: `Evidence ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			domain: 'example.com',
			publicationDate: index === 9 ? null : '2026-07-10',
			sourceType: index === 0 ? 'official' : 'news_report',
			supportingExcerpt: `Excerpt ${index + 1}`
		}));

		const updates = state.apply('agent.citations', JSON.stringify({ citations }));

		expect(updates).toHaveLength(1);
		expect(updates[0].citations).toHaveLength(10);
		expect(state.citationList().map((citation) => citation.citationNumber)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10
		]);
	});

	it('accepts internal citation URLs and removes unresolved or malformed provider markers', () => {
		const state = new StreamEventState();
		const updates = state.apply(
			'agent.citations',
			JSON.stringify({
				citations: [
					{
						citationNumber: 1,
						title: 'Provided notes',
						url: 'newsroom://provided-notes/1',
						domain: 'provided notes',
						sourceType: 'user_document',
						supportingExcerpt: 'The provided note confirms the claim.'
					}
				]
			})
		);

		expect(updates[0]?.citations?.[0]?.url).toBe('newsroom://provided-notes/1');
		const citations = state.citationList();
		expect(sanitizeUnresolvedCitationMarkers('Claim [1]. Unknown [99] and malformed [2.', citations)).toBe(
			'Claim [1]. Unknown and malformed.'
		);
		expect(
			sanitizeCitationEventData(
				'message',
				JSON.stringify({ choices: [{ delta: { content: 'Claim [1]. Unknown [99].' } }] }),
				citations
			)
		).toBe(JSON.stringify({ choices: [{ delta: { content: 'Claim [1]. Unknown.' } }] }));
	});

	it('buffers split citation markers while preserving the canonical final answer', () => {
		const citation = (citationNumber: number): CitationRecord => ({
			citationNumber,
			title: `Evidence ${citationNumber}`,
			url: `https://example.com/${citationNumber}`,
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Supported claim.'
		});
		const run = (value: string, citations: ReadonlyArray<CitationRecord>, split: number) => {
			const sanitizer = new StreamingCitationSanitizer(citations);
			const forward = (content: string) =>
				JSON.parse(
					sanitizeCitationEventData(
						'message',
						JSON.stringify({ choices: [{ delta: { content } }] }),
						citations,
						sanitizer
					)
				).choices[0].delta.content;
			const events = [forward(value.slice(0, split)), forward(value.slice(split)), sanitizer.flush()];
			return {
				events,
				raw: events.join(''),
				canonical: sanitizeUnresolvedCitationMarkers(value, citations)
			};
		};

		for (let split = 1; split < 'Claim [1].'.length; split += 1) {
			const known = run('Claim [1].', [citation(1)], split);
			expect(known.raw).toBe('Claim [1].');
			expect(known.raw).toBe(known.canonical);
			const unknown = run('Claim [1].', [], split);
			expect(unknown.raw).not.toContain('[1]');
			expect(unknown.canonical).toBe('Claim.');
		}
		for (let split = 1; split < 'Claim [1.'.length; split += 1) {
			const result = run('Claim [1.', [citation(1)], split);
			expect(result.raw).not.toContain('[1');
			expect(result.canonical).toBe('Claim.');
		}
		for (let split = 1; split < 'Claim [99].'.length; split += 1) {
			const unknown = run('Claim [99].', [citation(1)], split);
			expect(unknown.raw).not.toContain('[99]');
			expect(unknown.canonical).toBe('Claim.');
			const known = run('Claim [99].', [citation(99)], split);
			expect(known.raw).toBe('Claim [99].');
			expect(known.raw).toBe(known.canonical);
		}

		for (let split = 1; split < 'See [label](https://example.test/story).'.length; split += 1) {
			const result = run('See [label](https://example.test/story).', [], split);
			expect(result.raw).toBe('See [label](https://example.test/story).');
			expect(result.raw).toBe(result.canonical);
		}
		for (const value of [
			'See [1](https://example.test/story).',
			'![1](https://example.test/image.png)',
			'See [2026 report](url).',
			'See [provided notes](newsroom://provided-notes/1).',
			'See [document](document://brief/1).',
			'See [attachment](/api/attachments/1).'
		]) {
			for (const citations of [[], [citation(1)]]) {
				for (let split = 0; split <= value.length; split += 1) {
					const result = run(value, citations, split);
					expect(result.raw).toBe(value);
					expect(result.raw).toBe(result.canonical);
					expect(result.events.every((event) => !/\[\d[^\]]*\](?!\()/u.test(event))).toBe(true);
				}
			}
		}
		for (const value of [
			'See [1](javascript:alert(1)).',
			'See [2026 report](data:text/plain,x).',
			'See [1](not a valid destination).',
			'See [1]('
		]) {
			for (const citations of [[], [citation(1)]]) {
				for (let split = 0; split <= value.length; split += 1) {
					const result = run(value, citations, split);
					for (const event of result.events) {
						expect(event, `${value} split ${split}`).not.toMatch(/javascript|data:|file:|java%73cript/iu);
					}
					expect(result.raw).not.toMatch(/javascript|data:|file:|java%73cript/iu);
					const terminal = value.endsWith('.') ? '.' : '';
					const expected = value.includes('[1]') && citations.length ? `See [1]${terminal}` : `See${terminal}`;
					expect(result.canonical).toBe(expected);
					if (citations.length && value.includes('[1]')) expect(result.canonical).toContain('[1]');
					else expect(result.canonical).not.toMatch(/\[\d/u);
				}
			}
		}
		for (const value of [
			'See [label](javascript:alert(1)).',
			'See [label](data:text/plain,x).',
			'See [label](file:///tmp/story).',
			'See [1](java%73cript:alert(1)).',
			'See [1](javascript:foo(bar)).',
			'See [1](https://example.test/story with record 1 pass through.'
		]) {
			for (const citations of [[], [citation(1)]]) {
				for (let split = 0; split <= value.length; split += 1) {
					const result = run(value, citations, split);
					for (const event of result.events) {
						expect(event, `${value} split ${split}`).not.toMatch(/javascript|data:|file:|java%73cript/iu);
					}
					expect(result.raw).not.toMatch(/javascript|data:|file:|java%73cript/iu);
					expect(result.canonical).not.toMatch(/javascript|data:|file:|java%73cript/iu);
					const terminal = value.includes('with record') ? '' : '.';
					expect(result.canonical, `${value} split ${split} citations ${citations.length}`).toBe(
						value.includes('[label]')
							? `See label${terminal}`
							: citations.length
								? `See [1]${terminal}`
								: `See${terminal}`
					);
				}
			}
		}
		for (let split = 1; split < 'Array [1, 2] remains.'.length; split += 1) {
			const result = run('Array [1, 2] remains.', [], split);
			expect(result.raw).toBe('Array [1, 2] remains.');
			expect(result.canonical).toBe('Array [1, 2] remains.');
		}
		for (const value of ['Array [1,2,3] remains.', 'Array [1, 2,] remains.', 'Nested [[1, 2]] remains.']) {
			for (let split = 0; split <= value.length; split += 1) {
				const result = run(value, [], split);
				expect(result.raw).toBe(value);
				expect(result.canonical).toBe(value);
			}
		}
		for (const value of [
			'Inline code `[1]` and `[1x]` remain.',
			'```\n[1] [1x] [1](javascript:alert(1))\n```',
			'`[label](javascript:alert(1))` remains literal.'
		]) {
			for (let split = 0; split <= value.length; split += 1) {
				const result = run(value, [citation(1)], split);
				expect(result.raw).toBe(value);
				expect(result.canonical).toBe(value);
			}
		}
		for (let split = 1; split < 'Array [one, two] remains.'.length; split += 1) {
			const result = run('Array [one, two] remains.', [], split);
			expect(result.raw).toBe('Array [one, two] remains.');
		}
		for (let split = 1; split < 'Alpha [1]. Beta [2].'.length; split += 1) {
			const result = run('Alpha [1]. Beta [2].', [citation(1)], split);
			expect(result.raw).not.toContain('[2]');
			expect(result.canonical).toBe('Alpha [1]. Beta.');
		}
	});

	it('keeps event-wise output equal to final sanitization across replacement, flush, and abort', () => {
		const citation: CitationRecord = {
			citationNumber: 1,
			title: 'Evidence',
			url: 'https://example.com/evidence',
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Claim.'
		};
		const stream = new StreamingCitationSanitizer([citation]);
		const first = JSON.parse(
			sanitizeCitationEventData(
				'message',
				JSON.stringify({ choices: [{ delta: { content: 'Claim [' } }] }),
				[citation],
				stream
			)
		);
		const second = JSON.parse(
			sanitizeCitationEventData(
				'message',
				JSON.stringify({ choices: [{ delta: { content: '1].' } }] }),
				[citation],
				stream
			)
		);
		const emitted = `${first.choices[0].delta.content}${second.choices[0].delta.content}${stream.flush()}`;
		expect(emitted).toBe('Claim [1].');

		const replacement = new StreamingCitationSanitizer([citation]);
		expect(replacement.replace('Draft [')).toBe('Draft ');
		expect(replacement.push('1].')).toBe('[1].');
		expect(replacement.replace('Authoritative [')).toBe('Authoritative ');
		expect(replacement.push('1]. Tail')).toBe('[1]. Tail');

		const aborted = new StreamingCitationSanitizer();
		expect(aborted.push('Claim [1')).toBe('Claim ');
		expect(aborted.abort()).toBe('');
		expect(sanitizeUnresolvedCitationMarkers('Claim [1', [])).toBe('Claim');
		expect(sanitizeUnresolvedCitationMarkers('Claim [', [])).toBe('Claim');
		expect(sanitizeUnresolvedCitationMarkers('Claim [1 foo]', [])).toBe('Claim');
		expect(sanitizeUnresolvedCitationMarkers('Claim [1 foo', [])).toBe('Claim');
		expect(sanitizeUnresolvedCitationMarkers('Claim [1.\ncontinued', [])).toBe('Claim');
		expect(sanitizeUnresolvedCitationMarkers('Array [1,\n2', [])).toBe('Array [1,\n2');
	});

	it('emits safe prefixes immediately and buffers unresolved Markdown constructs', () => {
		const safePrefixes: Array<[string, string]> = [
			['See [label](', 'See '],
			['![alt](', ''],
			['Bracketed [ordinary', 'Bracketed '],
			['Array [one,', 'Array '],
			['`Code [x', '`Code [x'],
			['## [Status', '## '],
			['## Status ', '## Status ']
		];
		for (const [value, expected] of safePrefixes) {
			const sanitizer = new StreamingCitationSanitizer();
			expect(sanitizer.push(value), value).toBe(expected);
		}

		const lookahead = new StreamingCitationSanitizer();
		expect(lookahead.push('See [')).toBe('See ');
		expect(lookahead.push('f')).toBe('');
		expect(lookahead.flush()).toBe('[f');

		for (const value of ['Claim [', 'Claim [1', 'Claim [1.']) {
			const sanitizer = new StreamingCitationSanitizer();
			const first = sanitizer.push(value);
			const flushed = sanitizer.abort();
			const visible = `${first}${flushed}`;
			expect(first).toBe(value.slice(0, value.indexOf('[')));
			expect(visible).not.toContain('[');
			expect(sanitizer.emitted).toBe(visible);
			expect(sanitizeUnresolvedCitationMarkers(value, [])).not.toContain('[');
		}

		const known: CitationRecord = {
			citationNumber: 1,
			title: 'Evidence',
			url: 'https://example.com/evidence',
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Claim.'
		};
		const split = new StreamingCitationSanitizer([known]);
		expect(split.push('Claim [')).toBe('Claim ');
		expect(split.push('1].')).toBe('[1].');
		expect(split.flush()).toBe('');

		const ordinaryAbort = new StreamingCitationSanitizer();
		expect(ordinaryAbort.push('Bracketed [ordinary')).toBe('Bracketed ');
		expect(ordinaryAbort.abort()).toBe('[ordinary');
		expect(ordinaryAbort.emitted).toBe(sanitizeUnresolvedCitationMarkers('Bracketed [ordinary', []));

		const replacement = new StreamingCitationSanitizer([known]);
		expect(replacement.replace('Draft [')).toBe('Draft ');
		expect(replacement.replace('Authoritative')).toBe('Authoritative');
		expect(replacement.flush()).toBe('');
		expect(replacement.emitted).toBe('Authoritative');
	});

	it('does not defer safe whitespace before ordinary or citation-confusable brackets', () => {
		const cases = [
			['See [', ' first', 'See '],
			['Array [', '1, 2', 'Array '],
			['`Code [', 'x', '`Code ['],
			['## [', 'Status', '## '],
			['See [', 'label](', 'See '],
			['![', 'alt](', '']
		] as const;

		for (const [firstChunk, secondChunk, expectedFirst] of cases) {
			const sanitizer = new StreamingCitationSanitizer();
			expect(sanitizer.push(firstChunk), firstChunk).toBe(expectedFirst);
			sanitizer.push(secondChunk);
			sanitizer.abort();
		}
	});

	it('buffers incomplete and unsafe Markdown links/images until final classification', () => {
		const citation: CitationRecord = {
			citationNumber: 1,
			title: 'Evidence',
			url: 'https://example.com/evidence',
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Claim.'
		};
		const forward = (
			sanitizer: StreamingCitationSanitizer,
			content: string,
			citations: ReadonlyArray<CitationRecord>
		): string =>
			JSON.parse(
				sanitizeCitationEventData(
					'response.output_text.delta',
					JSON.stringify({ delta: content }),
					citations,
					sanitizer
				)
			).delta;

		const cases = [
			['See [label](', [], 'See label'],
			['![alt](', [], 'alt'],
			['See [label](javascript:alert(1)', [], 'See label'],
			['See [1](javascript:alert(1)', [citation], 'See [1]'],
			['See [label](https://example.test/story\u0000)', [], 'See label']
		] as const;

		for (const [value, citations, expected] of cases) {
			for (let split = 0; split <= value.length; split += 1) {
				const sanitizer = new StreamingCitationSanitizer(citations);
				const events = [
					forward(sanitizer, value.slice(0, split), citations),
					forward(sanitizer, value.slice(split), citations),
					sanitizer.flush()
				];
				for (const event of events) {
					expect(event, `${value} split ${split}`).not.toMatch(/\]\(|javascript:|data:|file:/iu);
				}
				expect(events.join(''), `${value} split ${split}`).toBe(expected);
			}
		}

		for (const safeLink of [
			'See [label](https://example.test/story (part))',
			'See [label](https://example.test/story\\(part\\))'
		]) {
		for (let split = 0; split <= safeLink.length; split += 1) {
			const sanitizer = new StreamingCitationSanitizer();
			const events = [
				forward(sanitizer, safeLink.slice(0, split), []),
				forward(sanitizer, safeLink.slice(split), []),
				sanitizer.flush()
			];
			expect(events.join(''), safeLink).toBe(safeLink);
			for (const event of events) {
				if (event.includes('](')) expect(event).toContain(')');
			}
		}
		}
	});

	it('fails closed when an unresolved Markdown construct exceeds its bounded buffer', () => {
		const sanitizer = new StreamingCitationSanitizer();
		const first = sanitizer.push('See [label](');
		const overflow = sanitizer.push('javascript:' + 'x'.repeat(70_000));
		const flushed = sanitizer.flush();
		expect(first).toBe('See ');
		expect(`${first}${overflow}${flushed}`).toBe('See label');
		expect(`${first}${overflow}${flushed}`).not.toMatch(/\]\(|javascript:/iu);
	});

	it('bounds only unresolved constructs and preserves arbitrarily large safe answers', () => {
		for (const length of [65_535, 65_536, 65_537, 262_144]) {
			const safe = 's'.repeat(length);
			expect(sanitizeUnresolvedCitationMarkers(safe, []), `whole buffer length ${length}`).toBe(safe);

			const sanitizer = new StreamingCitationSanitizer();
			const events: string[] = [];
			for (let offset = 0; offset < safe.length; offset += 4096) {
				events.push(sanitizer.push(safe.slice(offset, offset + 4096)));
			}
			events.push(sanitizer.flush());
			expect(events.join(''), `stream length ${length}`).toBe(safe);
			expect(sanitizer.canonical, `stream canonical length ${length}`).toBe(safe);
		}

		const citation: CitationRecord = {
			citationNumber: 1,
			title: 'Evidence',
			url: 'https://example.com/evidence',
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Claim.'
		};
		const sourced = `${'s'.repeat(65_536)} Claim [1]. See [label](https://example.test/story).`;
		const expected = sourced;
		expect(sanitizeUnresolvedCitationMarkers(sourced, [citation])).toBe(expected);

		const streamed = new StreamingCitationSanitizer([citation]);
		const streamedEvents: string[] = [];
		for (let offset = 0; offset < sourced.length; offset += 2048) {
			streamedEvents.push(streamed.push(sourced.slice(offset, offset + 2048)));
		}
		streamedEvents.push(streamed.flush());
		expect(streamedEvents.join('')).toBe(expected);
		expect(streamed.canonical).toBe(expected);
	});

	it('rejects only an oversized unsafe construct and resumes after its balanced close', () => {
		const value = `Safe prefix [label](javascript:${'x'.repeat(70_000)}) safe suffix`;
		const expected = 'Safe prefix label safe suffix';
		expect(sanitizeUnresolvedCitationMarkers(value, [])).toBe(expected);

		const sanitizer = new StreamingCitationSanitizer();
		const split = value.indexOf(')');
		const events = [sanitizer.push(value.slice(0, split)), sanitizer.push(value.slice(split)), sanitizer.flush()];
		expect(events.join('')).toBe(expected);
		expect(sanitizer.canonical).toBe(expected);
		expect(events.join('')).not.toMatch(/javascript:|\]\(/iu);

		const aborted = new StreamingCitationSanitizer();
		const prefix = aborted.push(`Safe prefix [label](javascript:${'x'.repeat(70_000)}`);
		const tail = aborted.abort();
		expect(`${prefix}${tail}`).toBe('Safe prefix label');
	});

	it('discards rejected destination bytes without growing retained state', () => {
		for (const length of [70_000, 270_000, 1_070_000]) {
			const sanitizer = new StreamingCitationSanitizer();
			expect(sanitizer.push('Safe prefix [label](javascript:')).toBe('Safe prefix ');
			sanitizer.push('x'.repeat(length));
			expect(sanitizer.bufferedCharacters, `retained bytes after ${length}`).toBeLessThanOrEqual(64 * 1024);
			expect(sanitizer.emitted).toBe('Safe prefix ');
			expect(sanitizer.abort()).toBe('label');
			expect(sanitizer.bufferedCharacters).toBe(0);
		}

		const nested = new StreamingCitationSanitizer();
		nested.push('Safe [label](javascript:foo(' + 'x'.repeat(70_000));
		const nestedTail = nested.push('\\)tail)) safe suffix');
		expect(`${nestedTail}${nested.flush()}`).toBe('label safe suffix');

		const citation: CitationRecord = {
			citationNumber: 1,
			title: 'Evidence',
			url: 'https://example.com/evidence',
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Claim.'
		};
		const authorized = new StreamingCitationSanitizer([citation]);
		authorized.push('Safe [1](javascript:' + 'x'.repeat(70_000));
		const authorizedTail = authorized.push(') safe suffix');
		expect(`${authorizedTail}${authorized.flush()}`).toBe('[1] safe suffix');
	});

	it('fails closed for every numeric-prefix bracket token across split events', () => {
		const knownCitation: CitationRecord = {
			citationNumber: 1,
			title: 'Evidence',
			url: 'https://example.com/evidence',
			domain: 'example.com',
			publicationDate: null,
			sourceType: 'official',
			supportingExcerpt: 'Claim.'
		};
		const malformed = [
			'[1x]',
			'[99abc]',
			'[1-foo]',
			'[1/2]',
			'[1.2]',
			'[1:2]',
			'[1\u00a0x]',
			'[1\u3000x]',
			'[1—x]',
			'[1\nx]',
			'[1x',
			'[99abc',
			'[1-foo',
			'[1/2',
			'[1 foo',
			'[[1x]]',
			'[1[2]]'
		];
		const forward = (
			sanitizer: StreamingCitationSanitizer,
			content: string,
			citations: ReadonlyArray<CitationRecord>
		): string =>
			JSON.parse(
				sanitizeCitationEventData(
					'message',
					JSON.stringify({ choices: [{ delta: { content } }] }),
					citations,
					sanitizer
				)
			).choices[0].delta.content;

		for (const citations of [[], [knownCitation]]) {
			for (const token of malformed) {
				const value = `Claim ${token} remains.`;
				for (let split = 0; split <= value.length; split += 1) {
					const sanitizer = new StreamingCitationSanitizer(citations);
					const first = forward(sanitizer, value.slice(0, split), citations);
					const second = forward(sanitizer, value.slice(split), citations);
					const flushed = sanitizer.flush();
					const events = [first, second, flushed];
					const raw = events.join('');
					const canonical = sanitizeUnresolvedCitationMarkers(value, citations);
					const expected = token.endsWith(']') ? 'Claim remains.' : 'Claim';

					for (const event of events) {
						expect(event, `${token} split ${split} raw event`).not.toMatch(/\[\d/u);
					}
					expect(raw, `${token} split ${split}`).not.toMatch(/\[\d/u);
					expect(canonical, `${token} split ${split}`).not.toMatch(/\[\d/u);
					expect(canonical, `${token} split ${split}`).toBe(expected);
					const replacement = JSON.parse(
						sanitizeCitationEventData(
							'agent.answer.replace',
							JSON.stringify({ content: canonical }),
							citations,
							new StreamingCitationSanitizer(citations)
						)
					);
					// Raw event assertions above never use this value; it models the
					// separate authoritative replacement that makes live and persisted
					// buffers identical after a conservative rejection.
					expect(replacement.content, `${token} split ${split} replacement`).toBe(canonical);
				}
			}
		}
	});

	it('requires a replacement reconciliation when removing a marker after safe text was emitted', () => {
		const sanitizer = new StreamingCitationSanitizer();
		const first = sanitizer.push('Claim [');
		const second = sanitizer.push('1].');
		const tail = sanitizer.flush();
		expect(`${first}${second}${tail}`).toBe('Claim .');
		expect(sanitizeUnresolvedCitationMarkers('Claim [1].', [])).toBe('Claim.');
		expect(sanitizer.emitted).toBe('Claim .');
	});

	it('formats SSE frames without changing event names', () => {
		expect(sseFrame('agent.tool.progress', '{"ok":true}')).toBe(
			'event: agent.tool.progress\ndata: {"ok":true}\n\n'
		);
	});
});
