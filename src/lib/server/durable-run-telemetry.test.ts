import { describe, expect, it } from 'vitest';
import {
	collectDurableRunEvents,
	MAX_DURABLE_TELEMETRY_EVENTS,
	MATERIAL_STREAM_GAP_MS,
	summarizeDurableRunTelemetry,
	traceIdFromHermesInput
} from './durable-run-telemetry';

function run(overrides: Record<string, unknown> = {}) {
	return {
		state: 'complete',
		inputJson: JSON.stringify({
			trace_id: 'trace_12345678',
			forwardedProps: { retrievalBackend: 'newscraft-local', archiveFallback: 'wayback' }
		}),
		createdAt: 1_000,
		startedAt: 1_200,
		completedAt: 5_000,
		cancelRequestedAt: null,
		...overrides
	} as any;
}

function event(eventType: string, createdAt: number, data: Record<string, unknown> = {}, cursor = 1) {
	return { eventType, createdAt, dataJson: JSON.stringify(data), cursor };
}

describe('durable run telemetry', () => {
	it('summarizes successful stages, usage, gaps, retries, and reconnects', () => {
		const summary = summarizeDurableRunTelemetry(run(), [
			event('run.started', 1_201, {}, 1),
			event('agent.tool.progress', 1_300, { id: 'search-1', name: 'openai_web_search' }, 2),
			event('agent.tool.progress', 1_301, { id: 'search-1', name: 'openai_web_search', result: 'private result' }, 3),
			event('agent.tool.progress', 1_400, { id: 'browser-1', name: 'browser_navigate' }, 4),
			event('agent.tool.progress', 1_450, { id: 'extract-1', name: 'web_extract' }, 5),
			event('agent.tool.progress', 1_455, { id: 'archive-1', name: 'archive_lookup' }, 6),
			event(
				'agent.source.read',
				1_460,
				{ source: { retrieval: { retrievalMode: 'wayback', archivedUrl: 'https://web.archive.org/web/1/https://example.test' } } },
				7
			),
			event('agent.source.read', 1_465, { source: { id: 'archive-source', retrieval: { retrievalMode: 'wayback' } } }, 8),
			event('response.output_text.delta', 1_500, { delta: 'answer text' }, 9),
			event('run.retry', 1_600, { retry: true }, 10),
			event('run.reconnecting', 1_700, {}, 11),
			event('run.reconnected', 1_750, {}, 12),
			event('response.completed', 1_750 + MATERIAL_STREAM_GAP_MS + 1, {}, 13)
		]);

		expect(summary).toMatchObject({
			trace_id: 'trace_12345678',
			terminal_state: 'complete',
			queue_wait_ms: 200,
			first_progress_ms: 201,
			first_answer_ms: 500,
			material_stream_gap_count: 1,
			max_material_stream_gap_ms: MATERIAL_STREAM_GAP_MS + 1,
			total_duration_ms: 4_000,
			retry_count: 1,
			reconnect_count: 1,
			cancel_requested: false,
			cancelled: false,
			failure_class: null,
			events_truncated: false,
			missing_stages: [],
			usage: {
				provider: 'hermes-chat',
				retrieval_backend: 'newscraft-local',
				archive_provider: 'wayback',
				search_calls: 1,
				browser_calls: 1,
				extraction_calls: 1,
				archive_calls: 1
			}
		});
	});

	it('counts one reconnect cycle for a reconnecting and reconnected pair', () => {
		const summary = summarizeDurableRunTelemetry(run(), [
			event('run.reconnecting', 1_500, {}, 1),
			event('run.reconnected', 1_600, {}, 2)
		]);

		expect(summary.reconnect_count).toBe(1);
	});

	it('reports missing stages without inventing timings', () => {
		const summary = summarizeDurableRunTelemetry(
			run({ state: 'queued', startedAt: null, completedAt: null }),
			[]
		);

		expect(summary).toMatchObject({
			queue_wait_ms: null,
			first_progress_ms: null,
			first_answer_ms: null,
			total_duration_ms: null,
			missing_stages: ['queue_wait', 'first_progress', 'first_answer', 'total_duration']
		});
	});

	it('keeps the bounded failure class and cancellation state', () => {
		const failed = summarizeDurableRunTelemetry(run({ state: 'failed' }), [
			event('run.started', 1_200, {}, 1),
			event('run.failed', 1_400, { failure_class: 'upstream', error: { message: 'secret answer' } }, 2)
		]);
		const cancelled = summarizeDurableRunTelemetry(
			run({ state: 'cancelled', cancelRequestedAt: 1_500, completedAt: 1_700 }),
			[
				event('run.cancel_requested', 1_500, {}, 1),
				event('run.cancelled', 1_700, { failure_class: 'cancelled' }, 2)
			]
		);

		expect(failed).toMatchObject({ terminal_state: 'failed', failure_class: 'upstream' });
		expect(cancelled).toMatchObject({
			terminal_state: 'cancelled',
			cancel_requested: true,
			cancelled: true,
			failure_class: 'cancelled'
		});
	});

	it('collects replayed event pages without crossing the requested run boundary', async () => {
		const calls: Array<[string, string, number, number]> = [];
		const firstPage = [event('run.started', 1_200, {}, 1), event('run.reconnecting', 1_300, {}, 2)];
		firstPage.push(
			...Array.from({ length: 998 }, (_, index) => event('run.progress', 1_300, {}, index + 3))
		);
		const pages = new Map<number, Array<any>>([
			[0, firstPage],
			[1000, [event('response.completed', 1_400, {}, 1001)]]
		]);
		const collection = await collectDurableRunEvents('account-a', 'run-a', async (accountId, runId, cursor, limit) => {
			calls.push([accountId, runId, cursor, limit]);
			return pages.get(cursor) || [];
		});

		expect(collection).toMatchObject({ truncated: false });
		expect(collection.events).toHaveLength(1001);
		expect(collection.events[0]).toMatchObject({ eventType: 'run.started', cursor: 1 });
		expect(collection.events.at(-1)).toMatchObject({ eventType: 'response.completed', cursor: 1001 });
		expect(calls).toEqual([
			['account-a', 'run-a', 0, 1000],
			['account-a', 'run-a', 1000, 1000]
		]);
	});

	it('caps terminal collection and reports truncation', async () => {
		const calls: Array<[number, number]> = [];
		const collection = await collectDurableRunEvents('account-a', 'run-a', async (_accountId, _runId, cursor, limit) => {
			calls.push([cursor, limit]);
			if (cursor < MAX_DURABLE_TELEMETRY_EVENTS) {
				return Array.from({ length: 1000 }, (_, index) => event('run.progress', 1_300, {}, cursor + index + 1));
			}
			return [event('response.completed', 1_400, {}, MAX_DURABLE_TELEMETRY_EVENTS + 1)];
		});

		expect(collection.events).toHaveLength(MAX_DURABLE_TELEMETRY_EVENTS);
		expect(collection.truncated).toBe(true);
		expect(calls.at(-1)).toEqual([MAX_DURABLE_TELEMETRY_EVENTS, 1]);
	});

	it('does not copy prompts, answers, URLs, account ids, tenant keys, or secrets', () => {
		const inputJson = JSON.stringify({
			trace_id: 'trace_12345678',
			account_id: 'account-secret',
			tenant_key: 'tenant-secret',
			prompt: 'private prompt',
			forwardedProps: { retrievalBackend: 'newscraft-local', archiveFallback: 'wayback' }
		});
		const summary = summarizeDurableRunTelemetry(
			run({ inputJson }),
			[
				event('run.started', 1_200, {}, 1),
				event('agent.tool.progress', 1_300, {
					id: 'tool-1',
					name: 'web_extract',
					url: 'https://user:password@example.test/private',
					content: 'private answer content'
				}, 2),
				event('response.output_text.delta', 1_400, { delta: 'private answer' }, 3)
			]
		);
		const encoded = JSON.stringify(summary);

		expect(traceIdFromHermesInput(inputJson)).toBe('trace_12345678');
		expect(encoded).toContain('trace_12345678');
		expect(encoded).not.toContain('account-secret');
		expect(encoded).not.toContain('tenant-secret');
		expect(encoded).not.toContain('private prompt');
		expect(encoded).not.toContain('private answer');
		expect(encoded).not.toContain('example.test');
		expect(encoded).not.toContain('password');
	});
});
