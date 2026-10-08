import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const dbMocks = vi.hoisted(() => ({ transaction: vi.fn(), update: vi.fn(), execute: vi.fn() }));
vi.mock('./index', () => ({ db: dbMocks }));

import {
	HERMES_LEASE_MS,
	HERMES_MAX_ANSWER_CHARS,
	HERMES_RECOVERY_GRACE_MS,
	claimHermesRunLease,
	createOrGetHermesRun,
	failQueuedHermesRun,
	reclaimQueuedOrExpiredHermesRuns,
	reconcileExpiredHermesRun,
	type HermesRunRecord
} from './hermes-runs';
import { hermesRunEvents, hermesRuns, messages, messageProvenance } from './schema';
import { parseToolMetadata } from '$lib/utils/tool-metadata';

const now = 200_000;
const expiresAt = now - HERMES_RECOVERY_GRACE_MS;

function runFixture(overrides: Partial<HermesRunRecord> = {}): HermesRunRecord {
	return {
		id: 'run-1', accountId: 'account-1', conversationId: 'conversation-1', assistantMessageId: 'assistant-1',
		state: 'researching', cursor: 0, workerCursor: 0, answerText: '', sourcesJson: '[]', citationsJson: '[]',
		toolsJson: '[]', errorMessage: null, leaseOwner: 'worker-old', leaseToken: 'lease-old',
		leaseExpiresAt: expiresAt, cancelRequestedAt: null, startedAt: 100_000, createdAt: 100_000,
		updatedAt: 100_000, completedAt: null, ...overrides
	} as HermesRunRecord;
}

function recordReconciliation(initial: HermesRunRecord | null, changedLease = false, managed = false) {
	let run = initial;
	const events: Array<Record<string, unknown>> = [];
	const insertions: Array<{ table: unknown; values: Record<string, unknown> }> = [];
	const mutations: Array<{ table: unknown; values: Record<string, unknown>; filter: unknown }> = [];
	const selectFilters: unknown[] = [];
	const tx = {
		execute: vi.fn(async (statement: unknown) => query(statement).sql.includes('agent_runtime_checkpoints')
			? managed ? [{ conversation_id: 'conversation-1' }] : []
			: [{ id: 'assistant-1' }]),
		select: () => {
			const query = {
				from: () => query,
				where: (filter: unknown) => { selectFilters.push(filter); return query; },
				for: () => query,
				orderBy: () => query,
				limit: async () => run ? [run] : []
			};
			return query;
		},
		update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({
			where: (filter: unknown) => {
				mutations.push({ table, values, filter });
				if (table === hermesRuns && !changedLease) run = { ...run, ...values } as HermesRunRecord;
				return {
					returning: async () => changedLease ? [] : [run],
					then: (resolve: (value: unknown) => unknown) => resolve(undefined)
				};
			}
		}) }),
		insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
			insertions.push({ table, values });
			if (table === hermesRunEvents) events.push(values);
			if (table === hermesRuns) run = values as HermesRunRecord;
			const inserted = {
				returning: async () => [values],
				onConflictDoUpdate: async () => undefined,
				onConflictDoNothing: () => inserted
			};
			return inserted;
		} })
	};
	dbMocks.transaction.mockImplementation(async operation => operation(tx));
	return { mutations, events, insertions, selectFilters, execute: tx.execute };
}

function query(filter: unknown) {
	return new PgDialect().sqlToQuery(filter as Parameters<PgDialect['sqlToQuery']>[0]);
}

describe('durable worker recovery grace', () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([0, HERMES_RECOVERY_GRACE_MS - 1])('keeps expired work active until the grace ends (%i ms)', async elapsed => {
		const run = runFixture();
		const recorded = recordReconciliation(run);
		expect(await reconcileExpiredHermesRun('account-1', 'run-1', expiresAt + elapsed)).toEqual(run);
		expect(recorded.mutations).toHaveLength(0);
		expect(recorded.events).toHaveLength(0);
	});

	it('settles once at the exact grace boundary with tenant, lease identity and grace cutoff predicates', async () => {
		const recorded = recordReconciliation(runFixture());
		expect(await reconcileExpiredHermesRun('account-1', 'run-1', now)).toMatchObject({
			state: 'failed', cursor: 1, completedAt: now, leaseOwner: null, leaseToken: null, leaseExpiresAt: null
		});
		expect(query(recorded.selectFilters[0]).params).toEqual(['run-1', 'account-1']);
		const guard = query(recorded.mutations.find(mutation => mutation.table === hermesRuns)!.filter);
		expect(guard.params).toEqual(['run-1', 'account-1', 'worker-old', 'lease-old', expiresAt]);
		expect(guard.sql).toContain('"hermes_runs"."lease_expires_at" <=');
		expect(recorded.events).toMatchObject([{ cursor: 1, eventType: 'run.failed' }]);
		await reconcileExpiredHermesRun('account-1', 'run-1', now + 1);
		expect(recorded.events).toHaveLength(1);
	});

	it.each([
		{ state: 'queued' as const },
		{ state: 'complete' as const },
		{ leaseOwner: null },
		{ leaseToken: null },
		{ leaseExpiresAt: null },
		{ leaseOwner: 'worker-new', leaseToken: 'lease-new', leaseExpiresAt: now + HERMES_LEASE_MS }
	])('leaves queued, terminal, unleased and renewed work untouched: %j', async overrides => {
		const run = runFixture(overrides);
		const recorded = recordReconciliation(run);
		expect(await reconcileExpiredHermesRun('account-1', 'run-1', now)).toEqual(run);
		expect(recorded.mutations).toHaveLength(0);
		expect(recorded.events).toHaveLength(0);
	});

	it('returns no run for a missing tenant-bound row', async () => {
		const recorded = recordReconciliation(null);
		expect(await reconcileExpiredHermesRun('account-other', 'run-1', now)).toBeNull();
		expect(query(recorded.selectFilters[0]).params).toEqual(['run-1', 'account-other']);
		expect(recorded.mutations).toHaveLength(0);
	});

	it('fails closed if the lease predicates no longer match before the update', async () => {
		const recorded = recordReconciliation(runFixture(), true);
		await expect(reconcileExpiredHermesRun('account-1', 'run-1', now)).rejects.toMatchObject({ code: 'stale_lease' });
		expect(recorded.events).toHaveLength(0);
	});

	it('settles cancellation after the same recovery grace', async () => {
		const recorded = recordReconciliation(runFixture({ state: 'cancel_requested', cancelRequestedAt: expiresAt }));
		expect(await reconcileExpiredHermesRun('account-1', 'run-1', now)).toMatchObject({ state: 'cancelled', cursor: 1 });
		expect(recorded.events).toMatchObject([{ eventType: 'run.cancelled' }]);
	});

	it.each(['researching', 'cancel_requested'] as const)('keeps managed %s recoverable until the provider turn is reconciled', async state => {
		const run = runFixture({ state });
		const recorded = recordReconciliation(run, false, true);
		expect(await reconcileExpiredHermesRun('account-1', 'run-1', now)).toEqual(run);
		expect(recorded.mutations).toHaveLength(0);
		expect(recorded.events).toHaveLength(0);
		const lookup = query(recorded.execute.mock.calls[0][0]);
		expect(lookup.params).toContain('account-1');
		expect(lookup.params).toContain('run-1');
	});

	it('issues a 90-second lease and permits worker reclaim immediately after expiry', async () => {
		const filters: unknown[] = [];
		const values: Array<Record<string, unknown>> = [];
		dbMocks.update.mockImplementation(() => ({ set: (value: Record<string, unknown>) => {
			values.push(value);
			return { where: (filter: unknown) => {
				filters.push(filter);
				return { returning: async () => [runFixture(value)] };
			} };
		} }));
		dbMocks.execute.mockResolvedValue([{ accountId: 'account-1', id: 'run-1' }]);
		const reclaimAt = expiresAt + 1;
		const claimed = await claimHermesRunLease('account-1', 'run-1', 'worker-new', reclaimAt);
		expect(claimed?.leaseExpiresAt).toBe(reclaimAt + 90_000);
		expect(query(filters[0]).params.at(-1)).toBe(reclaimAt);
		expect(query(filters[0]).sql).toContain('"hermes_runs"."lease_expires_at" <');
		const recovered = await reclaimQueuedOrExpiredHermesRuns('worker-new', 10, reclaimAt);
		expect(recovered).toHaveLength(1);
		expect(query(dbMocks.execute.mock.calls[0][0]).params).toContain(reclaimAt);
		expect(values[1].leaseExpiresAt).toBe(reclaimAt + HERMES_LEASE_MS);
	});
});

describe('durable resumed draft initialization', () => {
	beforeEach(() => vi.clearAllMocks());

	const input = {
		id: 'run-1', accountId: 'account-1', orgId: null, conversationId: 'conversation-1',
		assistantMessageId: 'assistant-1', userMessageId: null, idempotencyKey: 'resume-1',
		tenantKey: 'tenant-1', sessionId: 'session-1', inputJson: '{}'
	};

	it('preserves a seeded cited draft and its support when the replacement worker cannot start', async () => {
		const recorded = recordReconciliation(null);
		const draft = 'The existing sourced draft survives the failed resume [1].\n';
		const citation = {
			citationNumber: 1, title: 'Primary source', url: 'https://example.test/primary', domain: 'example.test',
			publicationDate: '2026-10-01', sourceType: 'primary', supportingExcerpt: 'The existing sourced draft.'
		};
		const created = await createOrGetHermesRun({
			...input, seededAnswerText: draft, seededCitationsJson: JSON.stringify([citation])
		});
		expect(created).toMatchObject({ created: true, run: { state: 'queued', answerText: draft } });
		expect(query(recorded.execute.mock.calls[0][0]).params).toEqual(['assistant-1', 'conversation-1', 'account-1']);
		const failed = await failQueuedHermesRun('account-1', 'run-1');
		expect(failed).toMatchObject({ state: 'failed', answerText: draft });
		const savedMessage = recorded.mutations.find(mutation => mutation.table === messages)!.values;
		expect(savedMessage).toMatchObject({ content: draft, partial: 1 });
		expect(parseToolMetadata(savedMessage.toolCalls as string).citations).toEqual([citation]);
		const savedProvenance = recorded.insertions.find(insertion => insertion.table === messageProvenance)!.values;
		expect(JSON.parse(savedProvenance.provenanceJson as string)).toMatchObject({
			citations: [citation], stream: { finishStatus: 'failed' }
		});
		expect(recorded.events).toMatchObject([{ eventType: 'run.failed' }]);
	});

	it('preserves existing source receipts, tool results and public activity in a queued failure snapshot', async () => {
		const tools = [{ id: 'tool-1', name: 'web_search', status: 'ok' }];
		const sources = [{ id: 'source-1', url: 'https://example.test/primary', title: 'Primary source', status: 'read' }];
		const plan = { source: 'model', steps: [{ id: 'read', label: 'Check the primary source', status: 'running' }] };
		const decisions = [{ id: 'primary-first', summary: 'I will check the official announcement first.' }];
		const recorded = recordReconciliation(runFixture({
			state: 'queued', leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
			sourcesJson: JSON.stringify(sources), toolsJson: JSON.stringify({ version: 1, tools, plan, decisions })
		}));
		await failQueuedHermesRun('account-1', 'run-1');
		const savedMessage = recorded.mutations.find(mutation => mutation.table === messages)!.values;
		expect(parseToolMetadata(savedMessage.toolCalls as string)).toMatchObject({ tools, sources, plan, decisions });
		const savedProvenance = recorded.insertions.find(insertion => insertion.table === messageProvenance)!.values;
		expect(JSON.parse(savedProvenance.provenanceJson as string)).toMatchObject({ tools, sources });
	});

	it('starts ordinary sends with an empty answer', async () => {
		recordReconciliation(null);
		expect((await createOrGetHermesRun(input)).run.answerText).toBe('');
	});

	it('rejects an idempotency conflict with another conversation inside the transaction', async () => {
		const existing = runFixture({ conversationId: 'different-conversation', idempotencyKey: input.idempotencyKey });
		let selects = 0;
		dbMocks.transaction.mockImplementation(operation => operation({
			execute: async () => [{ id: input.assistantMessageId }],
			select: () => ({ from: () => ({ where: () => {
				const result = { orderBy: () => result, limit: async () => ++selects === 1 ? [] : [existing] };
				return result;
			} }) }),
			insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) })
		}));
		await expect(createOrGetHermesRun(input)).rejects.toMatchObject({ code: 'invalid_input' });
	});

	it('accepts image inputs above the event limit within the worker input bound', async () => {
		recordReconciliation(null);
		const inputJson = JSON.stringify({ messages: [{ role: 'user', content: [
			{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(200 * 1024)}` } }
		] }] });
		expect((await createOrGetHermesRun({ ...input, inputJson })).run.inputJson).toBe(inputJson);
	});

	it('rejects input above the worker bound before storing a run', async () => {
		const inputJson = JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(512 * 1024) }] });
		await expect(createOrGetHermesRun({ ...input, inputJson })).rejects.toMatchObject({ code: 'invalid_input' });
		expect(dbMocks.transaction).not.toHaveBeenCalled();
	});

	it('bounds an oversized resume draft before saving it', async () => {
		recordReconciliation(null);
		const draft = 'a'.repeat(HERMES_MAX_ANSWER_CHARS + 20);
		const created = await createOrGetHermesRun({ ...input, seededAnswerText: draft });
		expect(created.run.answerText).toHaveLength(HERMES_MAX_ANSWER_CHARS);
		expect(created.run.answerText).toBe(draft.slice(0, HERMES_MAX_ANSWER_CHARS));
	});
});
