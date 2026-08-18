import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, addMessage } from './conversations';
import { ensureMigrated, sql } from './index';
import {
	HERMES_LEASE_MS,
	appendHermesRunEvent,
	claimHermesRunLease,
	createOrGetHermesRun,
	getActiveHermesRun,
	getHermesRun,
	listHermesRunEvents,
	reclaimQueuedOrExpiredHermesRuns,
	renewHermesRunLease,
	requestHermesRunCancellation,
	HermesRunRepositoryError
} from './hermes-runs';

const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

describe.skipIf(!databaseUrl)('durable Hermes run repository', () => {
	const accountA = `hermes-run-test-a-${Date.now()}`;
	const accountB = `hermes-run-test-b-${Date.now()}`;

	beforeAll(async () => {
		await ensureMigrated();
		const now = Date.now();
		await sql`
			INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES
				(${accountA}, ${`${accountA}@example.test`}, 'Hermes A', 'member', ${now}, ${now}),
				(${accountB}, ${`${accountB}@example.test`}, 'Hermes B', 'member', ${now}, ${now})
		`;
	});

	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${accountA} OR id = ${accountB}`;
		await sql.end({ timeout: 1 });
	});

	async function seed(operation: string) {
		const conversation = await createConversation(accountA);
		const user = await addMessage({ conversationId: conversation.id, role: 'user', content: 'Research this.' });
		const assistant = await addMessage({ conversationId: conversation.id, role: 'assistant', content: '', partial: true });
		const idempotencyKey = `${operation}-${conversation.id}`;
		return { conversation, user, assistant, idempotencyKey };
	}

	async function createRun(operation: string) {
		const seeded = await seed(operation);
		const result = await createOrGetHermesRun({
			accountId: accountA,
			orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id,
			userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id,
			idempotencyKey: seeded.idempotencyKey,
			tenantKey: `tenant-${accountA}`,
			sessionId: `session-${seeded.conversation.id}`,
			inputJson: JSON.stringify({ messages: [{ role: 'user', content: 'Research this.' }] }),
			seededCitationsJson: '[]'
		});
		return { ...seeded, run: result.run };
	}

	it('returns one run for two concurrent create calls with the same account and idempotency key', async () => {
		const seeded = await seed('concurrent-create');
		const input = {
			accountId: accountA,
			orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id,
			userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id,
			idempotencyKey: seeded.idempotencyKey,
			tenantKey: `tenant-${accountA}`,
			sessionId: `session-${seeded.conversation.id}`,
			inputJson: '{}'
		} as const;
		const [first, second] = await Promise.all([createOrGetHermesRun(input), createOrGetHermesRun(input)]);

		expect(first.run.id).toBe(second.run.id);
		expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
		expect(await getHermesRun(accountA, first.run.id)).toMatchObject({
		id: first.run.id,
		accountId: accountA,
		idempotencyKey: seeded.idempotencyKey
	});
	});

	it('appends ordered events atomically and advances the bounded answer snapshot', async () => {
		const { run } = await createRun('ordered-events');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		expect(claimed?.leaseToken).toEqual(expect.any(String));

		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'run.started',
			dataJson: '{}',
			workerCursor: 1
		});
		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'First.' }),
			workerCursor: 2
		});
		const final = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.completed',
			dataJson: '{}',
			workerCursor: 3
		});

		expect(final.run.cursor).toBe(3);
		expect(final.run.workerCursor).toBe(3);
		expect(final.run.answerText).toBe('First.');
		expect(final.run.state).toBe('complete');
		expect((await listHermesRunEvents(accountA, run.id)).map((event) => event.cursor)).toEqual([1, 2, 3]);
	});

	it('denies cross-account reads, callbacks, and cancellation', async () => {
		const { run } = await createRun('cross-account');
		expect(await getHermesRun(accountB, run.id)).toBeNull();
		await expect(
			appendHermesRunEvent(accountB, run.id, 'worker-a', 'wrong', {
				eventType: 'run.started',
				dataJson: '{}',
				workerCursor: 1
			})
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(requestHermesRunCancellation(accountB, run.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('rejects stale lease tokens and stale or non-monotonic callbacks', async () => {
		const { run } = await createRun('stale-lease');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		expect(claimed).not.toBeNull();
		await expect(renewHermesRunLease(accountA, run.id, 'worker-a', 'stale-token')).rejects.toMatchObject({
			code: 'stale_lease'
		});
		await expect(
			appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'run.started',
				dataJson: '{}',
				workerCursor: 2
			})
		).rejects.toMatchObject({ code: 'stale_callback' });
		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'run.started',
			dataJson: '{}',
			workerCursor: 1
		});
		await expect(
			appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'run.started',
				dataJson: '{}',
				workerCursor: 1
			})
		).rejects.toBeInstanceOf(HermesRunRepositoryError);
	});

	it('records cancellation and does not allow a cancelled run to be claimed', async () => {
		const { run } = await createRun('cancellation');
		const cancelled = await requestHermesRunCancellation(accountA, run.id, 'operator_stop');
		expect(cancelled.state).toBe('cancel_requested');
		expect(cancelled.cancelRequestedAt).toEqual(expect.any(Number));
		expect((await listHermesRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.cancel_requested');
		expect(await claimHermesRunLease(accountA, run.id, 'worker-a')).toBeNull();
	});

	it('reclaims queued and expired runs after a worker restart', async () => {
		const queued = await createRun('restart-reclaim-queued');
		const firstClaim = await claimHermesRunLease(accountA, queued.run.id, 'old-worker', 1000);
		expect(firstClaim).not.toBeNull();
		const reclaimed = await reclaimQueuedOrExpiredHermesRuns('new-worker', 10, 1000 + HERMES_LEASE_MS + 1);
		expect(reclaimed.map((run) => run.id)).toContain(queued.run.id);
		expect(reclaimed.find((run) => run.id === queued.run.id)).toMatchObject({
		leaseOwner: 'new-worker',
		state: 'researching'
	});
		expect(reclaimed.find((run) => run.id === queued.run.id)?.leaseToken).not.toBe(firstClaim?.leaseToken);

		const active = await getActiveHermesRun(accountA, queued.conversation.id);
		expect(active?.id).toBe(queued.run.id);
	});
});
