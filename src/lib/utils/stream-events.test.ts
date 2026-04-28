import { describe, expect, it } from 'vitest';
import { StreamEventState, sseFrame } from './stream-events';

describe('StreamEventState', () => {
	it('extracts Chat Completions deltas and Hermes tool progress', () => {
		const state = new StreamEventState();

		expect(
			state.apply('message', JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }), 1000)
		).toEqual([{ delta: 'Hello' }]);

		const started = state.apply(
			'hermes.tool.progress',
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
			'hermes.tool.progress',
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

	it('formats SSE frames without changing event names', () => {
		expect(sseFrame('hermes.tool.progress', '{"ok":true}')).toBe(
			'event: hermes.tool.progress\ndata: {"ok":true}\n\n'
		);
	});
});
