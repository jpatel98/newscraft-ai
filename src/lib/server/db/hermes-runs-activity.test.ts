import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const dbMocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('./index', () => ({ db: dbMocks }));

import {
	HERMES_MAX_ACTIVITY_DECISIONS,
	HERMES_RECOVERY_GRACE_MS,
	appendHermesRunEvents,
	applyHermesRunEvent,
	finalizeHermesRunCancellation,
	reconcileExpiredHermesRun,
	snapshotFromRun,
	type HermesRunRecord,
	type HermesRunEventRecord,
	type HermesRunSnapshot
} from './hermes-runs';
import { hermesRuns, hermesRunEvents, messages } from './schema';
import { parseToolMetadata } from '$lib/utils/tool-metadata';

const publicPlan = { source: 'model' as const, steps: [
	{ id: 'read', label: 'Read primary sources', status: 'running' as const },
	{ id: 'write', label: 'Write a cited answer', status: 'pending' as const }
] };
const publicDecision = {
	id: 'primary-first', summary: 'I will check the official announcement before comparing coverage.', stepId: 'read'
};

function runFixture(): HermesRunRecord {
	return {
		id: 'run-1', accountId: 'account-1', conversationId: 'conversation-1', assistantMessageId: 'assistant-1',
		state: 'researching', answerText: '', sourcesJson: '[]', citationsJson: '[]', toolsJson: '[]',
		errorMessage: null, cursor: 0, workerCursor: 0, leaseOwner: 'worker-1', leaseToken: 'lease-1',
		leaseExpiresAt: Date.now() + 60_000, startedAt: Date.now(), completedAt: null,
		cancelRequestedAt: null, createdAt: Date.now(), updatedAt: Date.now()
	} as HermesRunRecord;
}

function rehydrate(run: HermesRunRecord, snapshot: HermesRunSnapshot): HermesRunRecord {
	return { ...run, state: snapshot.state, answerText: snapshot.answerText, errorMessage: snapshot.errorMessage,
		sourcesJson: JSON.stringify(snapshot.sources), citationsJson: JSON.stringify(snapshot.citations),
		toolsJson: JSON.stringify({ version: 1, tools: snapshot.tools, plan: snapshot.plan, decisions: snapshot.decisions }) };
}

/** A transaction recorder exercises production projection code without a database. */
function recordTransaction(initial = runFixture()) {
	let run = { ...initial };
	const events: HermesRunEventRecord[] = [];
	const messageUpdates: Array<Record<string, unknown>> = [];
	const filters: unknown[] = [];
	const tx = {
		execute: vi.fn(async (query: unknown) => new PgDialect().sqlToQuery(query as any).sql.includes('agent_runtime_checkpoints')
			? [] : [{ id: run.id }]),
		select: () => {
			let table: unknown;
			const query = {
				from(value: unknown) { table = value; return query; },
				where(value: unknown) { filters.push(value); return query; },
				for() { return query; },
				orderBy() { return query; },
				limit: async (limit: number) => table === hermesRunEvents
					? [...events].filter(event => event.eventType !== 'run.cancel_requested').reverse().slice(0, limit)
					: [run]
			};
			return query;
		},
		insert: (table: unknown) => ({ values: (input: unknown) => {
			const rows = Array.isArray(input) ? input : [input];
			if (table === hermesRunEvents) events.push(...rows as HermesRunEventRecord[]);
			return { returning: async () => rows, onConflictDoUpdate: async () => undefined };
		} }),
		update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({
			where: (filter: unknown) => {
				filters.push(filter);
				if (table === hermesRuns) run = { ...run, ...values } as HermesRunRecord;
				if (table === messages) messageUpdates.push(values);
				return { returning: async () => [run], then: (resolve: (value: unknown) => unknown) => resolve(undefined) };
			}
		}) })
	};
	dbMocks.transaction.mockImplementation(async operation => operation(tx));
	return { get run() { return run; }, events, messageUpdates, filters, execute: tx.execute };
}

describe('durable public activity projection', () => {
	beforeEach(() => vi.clearAllMocks());

	it('reads old tool arrays and projects only named public activity fields from new envelopes', () => {
		const run = runFixture();
		run.toolsJson = JSON.stringify([{ id: 'tool-1', name: 'web_search', status: 'ok' }]);
		expect(snapshotFromRun(run).tools).toEqual([{ id: 'tool-1', name: 'web_search', status: 'ok' }]);
		expect(snapshotFromRun(run).plan).toBeUndefined();
		run.toolsJson = JSON.stringify({ tools: [], plan: { ...publicPlan, reasoning: 'hidden plan' },
			decisions: [{ ...publicDecision, reasoning: 'hidden decision' }, { id: 'bad', summary: 12 }],
			privateReasoning: 'hidden envelope' });
		const snapshot = snapshotFromRun(run);
		expect(snapshot.plan).toEqual(publicPlan);
		expect(snapshot.decisions).toEqual([publicDecision]);
		expect(JSON.stringify(snapshot)).not.toContain('hidden');
	});

	it('keeps latest full plans and unique bounded decisions across tool, answer and terminal events', () => {
		let run = runFixture();
		run = rehydrate(run, applyHermesRunEvent(run, 'agent.plan', JSON.stringify(publicPlan)));
		for (let index = 0; index < HERMES_MAX_ACTIVITY_DECISIONS + 2; index += 1) {
			run = rehydrate(run, applyHermesRunEvent(run, 'agent.decision', JSON.stringify({ id: `choice-${index}`, summary: `Choice ${index}` })));
		}
		run = rehydrate(run, applyHermesRunEvent(run, 'agent.decision', JSON.stringify({ id: 'choice-2', summary: 'Updated choice' })));
		run = rehydrate(run, applyHermesRunEvent(run, 'agent.tool.progress', JSON.stringify({ id: 'tool-1', name: 'web_search', status: 'ok' })));
		run = rehydrate(run, applyHermesRunEvent(run, 'agent.answer.replace', JSON.stringify({ content: 'Recorded answer.' })));
		const completedPlan = { source: 'model', steps: publicPlan.steps.map(step => ({ ...step, status: 'ok' })) };
		run = rehydrate(run, applyHermesRunEvent(run, 'agent.plan', JSON.stringify(completedPlan)));
		const completed = applyHermesRunEvent(run, 'response.completed', '{}');
		expect(completed.state).toBe('complete');
		expect(completed.answerText).toBe('Recorded answer.');
		expect(completed.plan).toEqual(completedPlan);
		expect(completed.decisions).toHaveLength(HERMES_MAX_ACTIVITY_DECISIONS);
		expect(completed.decisions?.[0]).toEqual({ id: 'choice-2', summary: 'Updated choice' });
		expect(completed.tools).toEqual([{ id: 'tool-1', name: 'web_search', status: 'ok' }]);
	});

	it('atomically persists clean activity for reconnect and message reload, and acknowledges duplicate terminal batches', async () => {
		const saved = recordTransaction();
		const inputs = [
			{ workerCursor: 1, eventType: 'agent.plan', dataJson: JSON.stringify({ ...publicPlan, reasoning: 'hidden plan' }) },
			{ workerCursor: 2, eventType: 'agent.decision', dataJson: JSON.stringify({ ...publicDecision, analysis: 'hidden choice' }) },
			{ workerCursor: 3, eventType: 'agent.answer.replace', dataJson: JSON.stringify({ content: 'Recorded answer.' }) },
			{ workerCursor: 4, eventType: 'response.completed', dataJson: '{}' }
		];
		const append = () => appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', inputs);
		const result = await append();
		const snapshot = snapshotFromRun(result.run);
		expect(snapshot).toMatchObject({ state: 'complete', plan: publicPlan, decisions: [publicDecision] });
		expect(saved.events.map(event => event.cursor)).toEqual([1, 2, 3, 4]);
		expect(JSON.parse(saved.events[0].dataJson)).toEqual(publicPlan);
		expect(JSON.parse(saved.events[1].dataJson)).toEqual(publicDecision);
		expect(JSON.stringify(saved.events)).not.toContain('hidden');
		const metadata = parseToolMetadata(saved.messageUpdates[0].toolCalls as string);
		expect(metadata).toMatchObject({ plan: publicPlan, decisions: [publicDecision] });
		const replay = await append();
		expect(replay.event.cursor).toBe(result.event.cursor);
		expect(saved.events).toHaveLength(4);
		expect(saved.messageUpdates).toHaveLength(1);
		await expect(appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', inputs.map(input =>
			input.eventType === 'agent.decision'
				? { ...input, dataJson: JSON.stringify({ ...publicDecision, summary: 'A different public decision.' }) }
				: input)))
			.rejects.toMatchObject({ code: 'stale_callback' });
		expect(saved.events).toHaveLength(4);
		const where = new PgDialect().sqlToQuery(saved.filters[0] as Parameters<PgDialect['sqlToQuery']>[0]);
		expect(where.params).toEqual(['run-1', 'account-1']);
	});

	it('binds an artifact callback to its owning account, conversation and answer before persistence', async () => {
		const saved = recordTransaction();
		saved.execute.mockResolvedValueOnce([]);
		await expect(appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', [{
			workerCursor: 1, eventType: 'artifact.ready', artifactRevisionId: 'artifact-1',
			dataJson: JSON.stringify({ artifact_revision_id: 'artifact-1' })
		}])).rejects.toMatchObject({ code: 'stale_callback' });
		const query = new PgDialect().sqlToQuery(saved.execute.mock.calls[0][0] as Parameters<PgDialect['sqlToQuery']>[0]);
		expect(query.params).toEqual(['artifact-1', 'account-1', 'conversation-1', 'assistant-1']);
		expect(query.sql).toContain("AND r.status = 'ready'");
		expect(saved.events).toHaveLength(0);
		expect(saved.messageUpdates).toHaveLength(0);
	});

	it.each(['cancellation', 'worker crash'])('preserves public activity when settling %s', async kind => {
		const run = runFixture();
		run.toolsJson = JSON.stringify({ version: 1, tools: [], plan: publicPlan, decisions: [publicDecision] });
		run.cursor = 2;
		run.workerCursor = 2;
		if (kind === 'cancellation') run.state = 'cancel_requested';
		else run.leaseExpiresAt = Date.now() - HERMES_RECOVERY_GRACE_MS - 1;
		const saved = recordTransaction(run);
		const settled = kind === 'cancellation'
			? await finalizeHermesRunCancellation('account-1', 'run-1')
			: await reconcileExpiredHermesRun('account-1', 'run-1');
		expect(settled?.state).toBe(kind === 'cancellation' ? 'cancelled' : 'failed');
		expect(parseToolMetadata(saved.messageUpdates[0].toolCalls as string))
			.toMatchObject({ plan: publicPlan, decisions: [publicDecision] });
		expect(snapshotFromRun(settled!)).toMatchObject({ plan: publicPlan, decisions: [publicDecision] });
	});

	it.each([
		['agent.plan', { steps: [{ id: 'bad', label: 4 }] }],
		['agent.decision', { id: 'private', reasoning: 'Never make this public' }],
		['response.reasoning.delta', { delta: 'Never make this public' }],
		['response.reasoning_summary_text.delta', { delta: 'Never make this public' }]
	])('rejects invalid or private %s callbacks before any database write', async (eventType, data) => {
		await expect(appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', [
			{ workerCursor: 1, eventType, dataJson: JSON.stringify(data) }
		])).rejects.toMatchObject({ code: 'invalid_input' });
		expect(dbMocks.transaction).not.toHaveBeenCalled();
	});
});
