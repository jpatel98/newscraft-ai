import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), upsertStoryClaims: vi.fn() }));
vi.mock('./index', () => ({ db: mocks }));
vi.mock('./story-claims', () => ({ upsertStoryClaims: mocks.upsertStoryClaims }));
vi.mock('../ledger-judge', () => ({ workerClaimJudge: async () => null }));

import { appendHermesRunEvents, type HermesRunRecord, type HermesRunEventRecord } from './hermes-runs';
import { hermesRuns, hermesRunEvents, messages } from './schema';

function runFixture(): HermesRunRecord {
	return {
		id: 'run-1', accountId: 'account-1', conversationId: 'conversation-1', assistantMessageId: 'assistant-1',
		state: 'researching', answerText: '', sourcesJson: '[]', citationsJson: '[]', toolsJson: '[]',
		errorMessage: null, cursor: 0, workerCursor: 0, leaseOwner: 'worker-1', leaseToken: 'lease-1',
		leaseExpiresAt: Date.now() + 60_000, startedAt: Date.now(), completedAt: null,
		cancelRequestedAt: null, createdAt: Date.now(), updatedAt: Date.now()
	} as HermesRunRecord;
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
	mocks.transaction.mockImplementation(async operation => operation(tx));
	return { get run() { return run; }, events, messageUpdates, filters, execute: tx.execute };
}


const block = (body: string, close = true) => `\n\n\`\`\`newscraft-ledger\n${body}${close ? '\n\`\`\`' : ''}\n`;
const ledgerJson = JSON.stringify({
	claims: [{ claim: 'Three soldiers were hurt.', status: 'confirmed', attributed_to: 'DND', citations: [3], date: '2026-07-02', needs_check: false }]
});

describe('story-ledger block on durable runs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.upsertStoryClaims.mockResolvedValue({ inserted: 1, updated: 0 });
	});

	it('strips the block from the stored event, the run answer and the message, and saves the claims', async () => {
		const saved = recordTransaction();
		const inputs = [
			{ workerCursor: 1, eventType: 'agent.answer.replace', dataJson: JSON.stringify({ content: `Three soldiers were hurt.${block(ledgerJson)}` }) },
			{ workerCursor: 2, eventType: 'agent.citations', dataJson: JSON.stringify({ citations: [{
				citationNumber: 3, title: 'DND statement', url: 'https://www.canada.ca/en/department-national-defence/news/1.html',
				domain: 'canada.ca', publicationDate: '2026-07-02', sourceType: 'official', supportingExcerpt: 'Three soldiers were hurt.'
			}] }) },
			{ workerCursor: 3, eventType: 'response.completed', dataJson: '{}' }
		];
		const result = await appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', inputs);
		expect(result.run.answerText).toBe('Three soldiers were hurt.');
		expect(JSON.stringify(saved.events)).not.toContain('newscraft-ledger');
		expect(JSON.parse(saved.events[0].dataJson)).toEqual({ content: 'Three soldiers were hurt.' });
		expect(saved.messageUpdates[0].content).toBe('Three soldiers were hurt.');
		expect(mocks.upsertStoryClaims).toHaveBeenCalledOnce();
		expect(mocks.upsertStoryClaims).toHaveBeenCalledWith('conversation-1', 'assistant-1', [
			{ claim: 'Three soldiers were hurt.', status: 'confirmed', attributedTo: 'DND', citations: [3], date: '2026-07-02', needsCheck: false }
		], expect.any(Number), expect.any(Function), expect.any(Map));
		// The claim's [3] resolves against this run's citations, so evidence can be judged.
		const pages = mocks.upsertStoryClaims.mock.calls[0][5] as Map<number, { url: string }>;
		expect(pages.get(3)?.url).toBe('https://www.canada.ca/en/department-national-defence/news/1.html');

		// A lost acknowledgment replays the same batch: still idempotent, no second save.
		const replay = await appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', inputs);
		expect(replay.event.cursor).toBe(result.event.cursor);
		expect(saved.events).toHaveLength(3);
		expect(mocks.upsertStoryClaims).toHaveBeenCalledOnce();
	});

	it('strips a block that arrived as streamed deltas when the run completes', async () => {
		const saved = recordTransaction();
		const text = `Answer text.${block(ledgerJson, false)}`;
		const result = await appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', [
			{ workerCursor: 1, eventType: 'response.output_text.delta', dataJson: JSON.stringify({ delta: text.slice(0, 20) }) },
			{ workerCursor: 2, eventType: 'response.output_text.delta', dataJson: JSON.stringify({ delta: text.slice(20) }) },
			{ workerCursor: 3, eventType: 'response.completed', dataJson: '{}' }
		]);
		expect(result.run.answerText).toBe('Answer text.');
		expect(saved.messageUpdates.at(-1)?.content).toBe('Answer text.');
		expect(mocks.upsertStoryClaims).toHaveBeenCalledOnce();
	});

	it('hides a half-streamed fence from the stored partial message', async () => {
		const saved = recordTransaction();
		await appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', [
			{ workerCursor: 1, eventType: 'response.output_text.delta', dataJson: JSON.stringify({ delta: 'Answer.\n\n```newscraft-led' }) },
			{ workerCursor: 2, eventType: 'agent.answer.partial', dataJson: '{}' }
		]);
		for (const update of saved.messageUpdates) expect(update.content).not.toContain('newscraft');
		expect(mocks.upsertStoryClaims).not.toHaveBeenCalled();
	});

	it('does not fail the run when saving claims fails, and still strips invalid-JSON blocks', async () => {
		mocks.upsertStoryClaims.mockRejectedValue(new Error('database unavailable'));
		const saved = recordTransaction();
		const result = await appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', [
			{ workerCursor: 1, eventType: 'agent.answer.replace', dataJson: JSON.stringify({ content: `Answer.${block(ledgerJson)}` }) },
			{ workerCursor: 2, eventType: 'response.completed', dataJson: '{}' }
		]);
		expect(result.run.state).toBe('complete');
		expect(result.run.answerText).toBe('Answer.');

		recordTransaction();
		mocks.upsertStoryClaims.mockClear();
		const second = await appendHermesRunEvents('account-1', 'run-1', 'worker-1', 'lease-1', [
			{ workerCursor: 1, eventType: 'agent.answer.replace', dataJson: JSON.stringify({ content: `Answer.${block('{broken')}` }) },
			{ workerCursor: 2, eventType: 'response.completed', dataJson: '{}' }
		]);
		expect(second.run.answerText).toBe('Answer.');
		expect(mocks.upsertStoryClaims).not.toHaveBeenCalled();
		expect(saved.events.length).toBeGreaterThan(0);
	});
});
