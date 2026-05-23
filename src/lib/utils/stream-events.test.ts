import { describe, expect, it } from 'vitest';
import { StreamEventState, sseFrame } from './stream-events';

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
				title: 'Story'
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
				status: 'queued'
			}),
			1000
		);
		const opened = state.apply(
			'agent.tool.progress',
			JSON.stringify({
				tool: 'browser_navigate',
				url: 'https://example.com/story',
				title: 'Story',
				status: 'start'
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

	it('does not mark search-result-only sources as used', () => {
		const state = new StreamEventState();

		const discovered = state.apply(
			'agent.source',
			JSON.stringify({
				url: 'https://example.com/search-result',
				title: 'Search result',
				status: 'start'
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
				url: 'https://example.com/first'
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
				url: 'https://example.com/second'
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

	it('formats SSE frames without changing event names', () => {
		expect(sseFrame('agent.tool.progress', '{"ok":true}')).toBe(
			'event: agent.tool.progress\ndata: {"ok":true}\n\n'
		);
	});
});
