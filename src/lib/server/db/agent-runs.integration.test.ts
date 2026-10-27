import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createConversation,
	addMessage,
	finalizePreparedAssistantMessage,
	getMessages,
	prepareDurableUserTurn,
	takeOverPreparedDurableTurn
} from './conversations';
import { ensureMigrated, sql } from './index';
import {
	AGENT_LEASE_MS,
	AGENT_RECOVERY_GRACE_MS,
	appendAgentRunEvent,
	appendAgentRunEvents,
	claimAgentRunLease,
	createOrGetAgentRun,
	failQueuedAgentRun,
	finalizeAgentRunCancellation,
	getActiveAgentRun,
	getAgentRun,
	getAgentRunForAssistant,
	getAgentRunSubscriptionState,
	listAgentRunEvents,
	listKnownAgentRunEvents,
	reclaimQueuedOrExpiredAgentRuns,
	reconcileExpiredAgentRun,
	renewAgentRunLease,
	releaseAgentRunLease,
	requestAgentRunCancellation,
	snapshotFromRun,
} from './agent-runs';
import { getMessageProvenance } from './message-provenance';
import { parseToolMetadata } from '$lib/utils/tool-metadata';

const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

describe.skipIf(!databaseUrl)('durable agent run repository', () => {
	const accountA = `agent-run-test-a-${Date.now()}`;
	const accountB = `agent-run-test-b-${Date.now()}`;

	beforeAll(async () => {
		await ensureMigrated();
		const now = Date.now();
		await sql`
			INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES
				(${accountA}, ${`${accountA}@example.test`}, 'Agent A', 'member', ${now}, ${now}),
				(${accountB}, ${`${accountB}@example.test`}, 'Agent B', 'member', ${now}, ${now})
		`;
	});

	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${accountA} OR id = ${accountB}`;
		await sql.end({ timeout: 1 });
	});

	async function seed(operation: string, accountId = accountA) {
		const conversation = await createConversation(accountId);
		const user = await addMessage({ conversationId: conversation.id, role: 'user', content: 'Research this.' });
		const assistant = await addMessage({ conversationId: conversation.id, role: 'assistant', content: '', partial: true });
		const idempotencyKey = `${operation}-${conversation.id}`;
		return { conversation, user, assistant, idempotencyKey };
	}

	async function createRun(operation: string, accountId = accountA, tenantKey = `tenant-${accountId}`) {
		const seeded = await seed(operation, accountId);
		const result = await createOrGetAgentRun({
			accountId,
			orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id,
			userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id,
			idempotencyKey: seeded.idempotencyKey,
			tenantKey,
			sessionId: `session-${seeded.conversation.id}`,
			inputJson: JSON.stringify({ messages: [{ role: 'user', content: 'Research this.' }] }),
			seededCitationsJson: '[]'
		});
		return { ...seeded, run: result.run };
	}

	it('atomically batches ordered events and replays a lost terminal acknowledgment', async () => {
		const { run, conversation, assistant } = await createRun('batch');
		const lease = (await claimAgentRunLease(accountA, run.id, 'batch-worker'))!;
		const events = [
			{ workerCursor: 1, eventType: 'run.started', dataJson: '{}' },
			{ workerCursor: 2, eventType: 'agent.answer.replace', dataJson: JSON.stringify({ content: 'Batch answer' }) },
			{ workerCursor: 3, eventType: 'response.completed', dataJson: '{}' }
		];
		const result = await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		expect(result.run.state).toBe('complete');
		expect(result.run.workerCursor).toBe(3);
		expect(result.run.answerText).toBe('Batch answer');
		const replay = await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		expect(replay.event.cursor).toBe(result.event.cursor);
		const saved = await listAgentRunEvents(accountA, run.id);
		expect(saved.map(event => event.eventType)).toEqual(events.map(event => event.eventType));
		expect(saved.map(event => event.cursor)).toEqual([1, 2, 3]);
		const messages = await getMessages(conversation.id);
		expect(messages.find(message => message.id === assistant.id)?.content).toBe('Batch answer');
		await expect(appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!,
			[...events.slice(0, 2), { ...events[2], dataJson: '{"changed":true}' }])).rejects.toMatchObject({ code: 'stale_callback' });
	});

	it('acknowledges a committed batch after cancellation intervenes', async () => {
		const { run } = await createRun('batch-cancel-replay');
		const lease = (await claimAgentRunLease(accountA, run.id, 'batch-worker'))!;
		const events = [{ workerCursor: 1, eventType: 'run.started', dataJson: '{}' }];
		await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		await requestAgentRunCancellation(accountA, run.id);
		const replay = await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		expect(replay.run.state).toBe('cancel_requested');
		expect(replay.run.workerCursor).toBe(1);
		const cancelled = await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!,
			[{ workerCursor: 2, eventType: 'run.cancelled', dataJson: '{}' }]);
		expect(cancelled.run.state).toBe('cancelled');
	});

	it('replays public plans and decisions from the run and saved message without private fields', async () => {
		const { run, conversation, assistant } = await createRun('public-activity-replay');
		const lease = (await claimAgentRunLease(accountA, run.id, 'activity-worker'))!;
		const plan = { source: 'model', steps: [
			{ id: 'read', label: 'Read primary sources', status: 'running' },
			{ id: 'write', label: 'Write a cited answer', status: 'pending' }
		] };
		const completedPlan = { ...plan, steps: plan.steps.map(step => ({ ...step, status: 'ok' })) };
		const decision = { id: 'official-first', summary: 'I checked the official announcement first.', stepId: 'read' };
		const events = [
			{ workerCursor: 1, eventType: 'run.started', dataJson: '{}' },
			{ workerCursor: 2, eventType: 'agent.plan', dataJson: JSON.stringify({ ...plan, reasoning: 'private trace' }) },
			{ workerCursor: 3, eventType: 'agent.decision', dataJson: JSON.stringify({ ...decision, analysis: 'private trace' }) },
			{ workerCursor: 4, eventType: 'agent.plan', dataJson: JSON.stringify(completedPlan) },
			{ workerCursor: 5, eventType: 'agent.answer.replace', dataJson: JSON.stringify({ content: 'Recorded answer.' }) },
			{ workerCursor: 6, eventType: 'response.completed', dataJson: '{}' }
		];
		const result = await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		expect(snapshotFromRun(result.run)).toMatchObject({ state: 'complete', plan: completedPlan, decisions: [decision] });
		const savedMessage = (await getMessages(conversation.id)).find(message => message.id === assistant.id)!;
		expect(parseToolMetadata(savedMessage.toolCalls)).toMatchObject({ plan: completedPlan, decisions: [decision] });
		const recordedEvents = await listAgentRunEvents(accountA, run.id);
		expect(JSON.parse(recordedEvents[1].dataJson)).toEqual(plan);
		expect(JSON.parse(recordedEvents[2].dataJson)).toEqual(decision);
		expect(JSON.stringify(recordedEvents)).not.toContain('private trace');
		expect((await listKnownAgentRunEvents(accountA, run.id, 4)).map(event => event.cursor)).toEqual([5, 6]);
		const replay = await appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		expect(replay.event.cursor).toBe(6);
		expect(await listAgentRunEvents(accountA, run.id)).toHaveLength(6);
	});

	it('rolls back a batch with an event after completion and rejects invalid cursors and owners', async () => {
		const { run } = await createRun('batch-rollback');
		const lease = (await claimAgentRunLease(accountA, run.id, 'batch-worker'))!;
		const append = (events: Parameters<typeof appendAgentRunEvents>[4]) =>
			appendAgentRunEvents(accountA, run.id, lease.leaseOwner!, lease.leaseToken!, events);
		await expect(append([
			{ workerCursor: 1, eventType: 'response.completed', dataJson: '{}' },
			{ workerCursor: 2, eventType: 'agent.answer.replace', dataJson: '{"text":"late"}' }
		])).rejects.toMatchObject({ code: 'terminal' });
		expect((await getAgentRun(accountA, run.id))?.workerCursor).toBe(0);
		expect(await listAgentRunEvents(accountA, run.id)).toEqual([]);
		await expect(append([{ workerCursor: 2, eventType: 'run.started', dataJson: '{}' }])).rejects.toMatchObject({ code: 'stale_callback' });
		await expect(appendAgentRunEvents(accountB, run.id, lease.leaseOwner!, lease.leaseToken!,
			[{ workerCursor: 1, eventType: 'run.started', dataJson: '{}' }])).rejects.toMatchObject({ code: 'not_found' });
		await requestAgentRunCancellation(accountA, run.id);
		await expect(append([{ workerCursor: 1, eventType: 'run.started', dataJson: '{}' }])).rejects.toMatchObject({ code: 'stale_callback' });
		expect((await append([{ workerCursor: 1, eventType: 'run.cancelled', dataJson: '{}' }])).run.state).toBe('cancelled');
	});

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
		const [first, second] = await Promise.all([createOrGetAgentRun(input), createOrGetAgentRun(input)]);

		expect(first.run.id).toBe(second.run.id);
		expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
		expect(await getAgentRun(accountA, first.run.id)).toMatchObject({
			id: first.run.id,
			accountId: accountA,
			idempotencyKey: seeded.idempotencyKey
		});
	});

	it('creates one durable turn for simultaneous identical submissions with different browser keys', async () => {
		const conversation = await createConversation(accountA);
		const input = {
			accountId: accountA,
			conversationId: conversation.id,
			content: 'Same newsroom request.',
			dedupeKey: 'send',
			now: Date.now()
		} as const;
		const [first, second] = await Promise.all([
			prepareDurableUserTurn(input),
			prepareDurableUserTurn(input)
		]);

		expect(first.user.id).toBe(second.user.id);
		expect(first.assistant.id).toBe(second.assistant.id);
		expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
		expect(await getMessages(conversation.id)).toMatchObject([
			{ role: 'user', content: 'Same newsroom request.' },
			{ role: 'assistant', content: '', partial: 1 }
		]);
		await expect(
			prepareDurableUserTurn({ ...input, accountId: accountB })
		).rejects.toThrow('conversation not found');
	});

	it('rejects a concurrent account key collision across different conversations', async () => {
		const left = await seed('key-binding-left');
		const right = await seed('key-binding-right');
		const idempotencyKey = `shared-${left.conversation.id}`;
		const results = await Promise.allSettled([left, right].map(seeded => createOrGetAgentRun({
			accountId: accountA, orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id, userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id, idempotencyKey,
			tenantKey: `tenant-${accountA}`, sessionId: `session-${seeded.conversation.id}`, inputJson: '{}'
		})));
		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'invalid_input' } });
		const rows = await sql`SELECT conversation_id FROM agent_runs WHERE account_id = ${accountA} AND idempotency_key = ${idempotencyKey}`;
		expect(rows).toHaveLength(1);
	});

	it('does not merge different output actions on the same answer', async () => {
		const conversation = await createConversation(accountA);
		const now = Date.now();
		const first = await prepareDurableUserTurn({
			accountId: accountA,
			conversationId: conversation.id,
			content: 'Create a broadcast script.',
			dedupeKey: 'output:broadcast:source-a',
			now
		});
		const second = await prepareDurableUserTurn({
			accountId: accountA,
			conversationId: conversation.id,
			content: 'Create a broadcast script.',
			dedupeKey: 'output:social:source-a',
			now: now + 2
		});

		expect(second.user.id).not.toBe(first.user.id);
		expect(second.assistant.id).not.toBe(first.assistant.id);
	});

	it('lets one waiter take over an abandoned preflight without a late-owner race', async () => {
		const conversation = await createConversation(accountA);
		const prepared = await prepareDurableUserTurn({
			accountId: accountA,
			conversationId: conversation.id,
			content: 'Research the latest Ontario update.',
			dedupeKey: 'send',
			now: 1_000
		});
		const takeoverToken = await takeOverPreparedDurableTurn({
			accountId: accountA,
			conversationId: conversation.id,
			messageId: prepared.assistant.id,
			staleBefore: 1_001,
			now: 2_000
		});
		expect(takeoverToken).toBe(2_000);

		const runInput = {
			accountId: accountA,
			orgId: conversation.orgId,
			conversationId: conversation.id,
			userMessageId: prepared.user.id,
			assistantMessageId: prepared.assistant.id,
			idempotencyKey: `takeover-${conversation.id}`,
			tenantKey: `tenant-${accountA}`,
			sessionId: `session-${conversation.id}`,
			inputJson: '{}'
		};
		await expect(
			createOrGetAgentRun({ ...runInput, preparedClaimToken: prepared.claimToken })
		).rejects.toMatchObject({ code: 'stale_callback' });
		await expect(
			finalizePreparedAssistantMessage({
				accountId: accountA,
				conversationId: conversation.id,
				messageId: prepared.assistant.id,
				claimToken: prepared.claimToken,
				content: 'Late owner failure'
			})
		).resolves.toBeUndefined();
		const claimed = await createOrGetAgentRun({
			...runInput,
			preparedClaimToken: takeoverToken as number
		});
		expect(claimed.created).toBe(true);
	});

	it('reuses one active assistant run for concurrent resumes with different browser keys', async () => {
		const seeded = await seed('concurrent-resume');
		const base = {
			accountId: accountA,
			orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id,
			userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id,
			tenantKey: `tenant-${accountA}`,
			sessionId: `session-${seeded.conversation.id}`,
			inputJson: '{}'
		} as const;
		const original = await createOrGetAgentRun({
			...base,
			idempotencyKey: 'resume-original',
			seededCitationsJson: '[]'
		});

		const [firstResume, secondResume] = await Promise.all([
			createOrGetAgentRun({ ...base, idempotencyKey: 'resume-browser-a' }),
			createOrGetAgentRun({ ...base, idempotencyKey: 'resume-browser-b' })
		]);

		expect(firstResume.created).toBe(false);
		expect(secondResume.created).toBe(false);
		expect(firstResume.run.id).toBe(original.run.id);
		expect(secondResume.run.id).toBe(original.run.id);
		expect((await getAgentRunForAssistant(accountA, seeded.conversation.id, seeded.assistant.id))?.id).toBe(
			original.run.id
		);
	});

	it('appends ordered events atomically and advances the bounded answer snapshot', async () => {
		const { run } = await createRun('ordered-events');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		expect(claimed?.leaseToken).toEqual(expect.any(String));

		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'run.started',
			dataJson: '{}',
			workerCursor: 1
		});
		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'First.' }),
			workerCursor: 2
		});
		const final = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.completed',
			dataJson: '{}',
			workerCursor: 3
		});

		expect(final.run.cursor).toBe(3);
		expect(final.run.workerCursor).toBe(3);
		expect(final.run.answerText).toBe('First.');
		expect(final.run.state).toBe('complete');
		expect((await listAgentRunEvents(accountA, run.id)).map((event) => event.cursor)).toEqual([1, 2, 3]);
		expect((await getMessages(run.conversationId)).find((message) => message.id === run.assistantMessageId)).toMatchObject({
			content: 'First.',
			partial: 0
		});
		expect((await getMessageProvenance(run.assistantMessageId))?.provenanceJson).toContain('completed');
	});

	it('preserves source, citation, tool, text, terminal, and provenance snapshots', async () => {
		const seeded = await seed('all-event-kinds');
		const citation = {
			citationNumber: 1,
			title: 'Primary source',
			url: 'https://example.test/primary',
			domain: 'example.test',
			publicationDate: '2026-08-19',
			sourceType: 'primary',
			supportingExcerpt: 'Recorded evidence'
		};
		const { run } = await createOrGetAgentRun({
			accountId: accountA,
			orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id,
			userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id,
			idempotencyKey: seeded.idempotencyKey,
			tenantKey: `tenant-${accountA}`,
			sessionId: `session-${seeded.conversation.id}`,
			inputJson: '{}',
			seededCitationsJson: JSON.stringify([citation])
		});
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		const source = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'agent.source.read',
			dataJson: JSON.stringify({ source: { id: 'source-1', url: citation.url, title: citation.title } }),
			workerCursor: 1
		});
		expect(JSON.parse(source.run.sourcesJson)).toEqual([
			{ id: 'source-1', url: citation.url, title: citation.title }
		]);

		const withCitation = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'agent.citations',
			dataJson: JSON.stringify({ citations: [citation] }),
			workerCursor: 2
		});
		expect(JSON.parse(withCitation.run.citationsJson)).toEqual([citation]);
		const metadataAfterCitation = (await getMessages(seeded.conversation.id)).find(
			(message) => message.id === seeded.assistant.id
		)?.toolCalls;
		expect(metadataAfterCitation).toContain('Primary source');

		const withTool = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'agent.tool.progress',
			dataJson: JSON.stringify({ id: 'tool-1', name: 'search', status: 'completed' }),
			workerCursor: 3
		});
		expect(JSON.parse(withTool.run.toolsJson)).toEqual([
			{ id: 'tool-1', name: 'search', status: 'completed' }
		]);
		const metadataAfterTool = (await getMessages(seeded.conversation.id)).find(
			(message) => message.id === seeded.assistant.id
		)?.toolCalls;
		expect(metadataAfterTool).not.toBe(metadataAfterCitation);

		const withText = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'The source supports this [1].' }),
			workerCursor: 4
		});
		expect(withText.run.answerText).toBe('The source supports this [1].');
		expect(withText.run.sourcesJson).toBe(withTool.run.sourcesJson);
		expect(withText.run.citationsJson).toBe(withTool.run.citationsJson);
		expect(withText.run.toolsJson).toBe(withTool.run.toolsJson);
		const metadataAfterText = (await getMessages(seeded.conversation.id)).find(
			(message) => message.id === seeded.assistant.id
		)?.toolCalls;
		expect(metadataAfterText).toBe(metadataAfterTool);

		const terminal = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.completed',
			dataJson: '{}',
			workerCursor: 5
		});
		expect(terminal.run.state).toBe('complete');
		expect(terminal.run.sourcesJson).toBe(withText.run.sourcesJson);
		expect(JSON.parse(terminal.run.citationsJson)).toEqual([citation]);
		expect(JSON.parse(terminal.run.toolsJson)).toEqual(JSON.parse(withTool.run.toolsJson));
		const message = (await getMessages(seeded.conversation.id)).find(
			(row) => row.id === seeded.assistant.id
		);
		expect(message).toMatchObject({ content: 'The source supports this [1].', partial: 0 });
		expect(message?.toolCalls).toContain('tool-1');
		const provenance = await getMessageProvenance(seeded.assistant.id);
		const provenanceJson = JSON.parse(provenance?.provenanceJson || '{}') as {
			stream?: { done?: boolean; finishStatus?: string; assistantChars?: number };
		};
		expect(provenanceJson.stream).toMatchObject({
			done: true,
			finishStatus: 'completed',
			assistantChars: 'The source supports this [1].'.length
		});
		expect((await listAgentRunEvents(accountA, run.id)).map((event) => event.eventType)).toEqual([
			'agent.source.read',
			'agent.citations',
			'agent.tool.progress',
			'response.output_text.delta',
			'response.completed'
		]);
	});

	it('serializes concurrent callbacks under the run row lock', async () => {
		const { run } = await createRun('concurrent-callbacks');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		const results = await Promise.allSettled([
			appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'one' }),
				workerCursor: 1
			}),
			appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'two' }),
				workerCursor: 1
			})
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const rejected = results.find((result) => result.status === 'rejected');
		expect(rejected).toMatchObject({ reason: { code: 'stale_callback' } });
		expect((await listAgentRunEvents(accountA, run.id)).map((event) => event.cursor)).toEqual([1]);
		expect((await getAgentRun(accountA, run.id))?.workerCursor).toBe(1);
	});

	it('rolls back the event and run snapshot when a durable message write fails', async () => {
		const { run, conversation, assistant } = await createRun('callback-rollback');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		await sql`
			CREATE FUNCTION agent_item6_fail_message_update() RETURNS trigger
			LANGUAGE plpgsql AS $item6$
			BEGIN
				IF NEW.content = 'ROLLBACK_MARKER' THEN
					RAISE EXCEPTION 'item6 rollback fixture';
				END IF;
				RETURN NEW;
			END
			$item6$
		`;
		await sql`
			CREATE TRIGGER agent_item6_fail_message_update
			BEFORE UPDATE OF content ON messages
			FOR EACH ROW EXECUTE FUNCTION agent_item6_fail_message_update()
		`;
		try {
			await expect(
				appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
					eventType: 'response.output_text.delta',
					dataJson: JSON.stringify({ delta: 'ROLLBACK_MARKER' }),
					workerCursor: 1
				})
			).rejects.toThrow('Failed query: update "messages"');
		} finally {
			await sql`DROP TRIGGER IF EXISTS agent_item6_fail_message_update ON messages`;
			await sql`DROP FUNCTION IF EXISTS agent_item6_fail_message_update()`;
		}

		expect(await getAgentRun(accountA, run.id)).toMatchObject({
			cursor: 0,
			workerCursor: 0,
			state: 'researching',
			answerText: ''
		});
		expect(await listAgentRunEvents(accountA, run.id)).toEqual([]);
		expect((await getMessages(conversation.id)).find((message) => message.id === assistant.id)).toMatchObject({
			content: '',
			partial: 1
		});
	});

	it('rejects an expired lease before writing a callback event', async () => {
		const { run } = await createRun('expired-callback-lease');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		await sql`UPDATE agent_runs SET lease_expires_at = 0 WHERE id = ${run.id} AND account_id = ${accountA}`;

		await expect(
			appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'expired' }),
				workerCursor: 1
			})
		).rejects.toMatchObject({ code: 'stale_lease' });
		expect(await listAgentRunEvents(accountA, run.id)).toEqual([]);
		expect((await getAgentRun(accountA, run.id))?.cursor).toBe(0);
	});

	it('returns a current reconnect snapshot and only newer events', async () => {
		const { run } = await createRun('reconnect-snapshot');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'Before reconnect.' }),
			workerCursor: 1
		});
		const snapshot = await getAgentRunSubscriptionState(accountA, run.id);
		expect(snapshot).toMatchObject({ state: 'writing', cursor: 1 });
		expect(await listKnownAgentRunEvents(accountA, run.id, snapshot!.cursor)).toEqual([]);

		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: ' After reconnect.' }),
			workerCursor: 2
		});
		expect(await listKnownAgentRunEvents(accountA, run.id, snapshot!.cursor)).toMatchObject([
			{ cursor: 2, eventType: 'response.output_text.delta' }
		]);
	});

	it('avoids projection writes for ordinary text callbacks after the first event', async () => {
		const { run } = await createRun('text-update-shape');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'run.started',
			dataJson: '{}',
			workerCursor: 1
		});
		const options = (sql as any).options;
		const previousDebug = options.debug;
		const queries: string[] = [];
		options.debug = (_connectionId: number, query: string) => queries.push(query);
		try {
			await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'Only text changes.' }),
				workerCursor: 2
			});
		} finally {
			options.debug = previousDebug;
		}

		const runSelects = queries.filter((query) => /select[\s\S]+from "agent_runs"/i.test(query));
		const runUpdate = queries.find((query) => /update "agent_runs"/i.test(query));
		const messageUpdate = queries.find((query) => /update "messages"/i.test(query));
		const provenanceWrite = queries.find((query) => /(?:insert|update) "message_provenance"/i.test(query));
		const conversationUpdate = queries.find((query) => /update "conversations"/i.test(query));
		expect(runSelects).toHaveLength(1);
		expect(runSelects[0]).toMatch(/for update/i);
		expect(runUpdate).toBeDefined();
		expect(runUpdate?.split(' returning ')[0]).not.toMatch(/sources_json|citations_json|tools_json/i);
		expect(messageUpdate).toBeUndefined();
		expect(provenanceWrite).toBeUndefined();
		expect(conversationUpdate).toBeUndefined();
	});

	it('keeps only citation records used by the completed durable answer', async () => {
		const seeded = await seed('used-citations');
		const citations = [1, 3].map((citationNumber) => ({
			citationNumber,
			title: `Source ${citationNumber}`,
			url: `https://example.test/source-${citationNumber}`,
			domain: citationNumber === 3 ? 'Unknown source' : 'example.test',
			publicationDate: '2026-08-19',
			sourceType: 'primary',
			supportingExcerpt: `Evidence ${citationNumber}`
		}));
		const { run } = await createOrGetAgentRun({
			accountId: accountA,
			orgId: seeded.conversation.orgId,
			conversationId: seeded.conversation.id,
			userMessageId: seeded.user.id,
			assistantMessageId: seeded.assistant.id,
			idempotencyKey: seeded.idempotencyKey,
			tenantKey: `tenant-${accountA}`,
			sessionId: `session-${seeded.conversation.id}`,
			inputJson: '{}',
			seededCitationsJson: JSON.stringify(citations)
		});
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'The prior source supports this [3].' }),
			workerCursor: 1
		});
		const final = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.completed',
			dataJson: '{}',
			workerCursor: 2
		});

		expect(JSON.parse(final.run.citationsJson)).toEqual([expect.objectContaining({ citationNumber: 3 })]);
		expect(JSON.parse(final.run.citationsJson)[0].domain).toBe('example.test');
		expect((await getMessages(seeded.conversation.id)).find((message) => message.id === seeded.assistant.id))
			.toMatchObject({ partial: 0 });
	});

	it('removes an unresolved marker from a completed durable answer', async () => {
		const { run, conversation, assistant } = await createRun('dangling-citation');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'This claim has no saved source [3].' }),
			workerCursor: 1
		});
		const final = await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.completed',
			dataJson: '{}',
			workerCursor: 2
		});

		expect(final.run.answerText).toBe('This claim has no saved source.');
		expect((await getMessages(conversation.id)).find((message) => message.id === assistant.id)?.content).toBe(
			'This claim has no saved source.'
		);
	});

	it('denies cross-account reads, callbacks, and cancellation', async () => {
		const { run } = await createRun('cross-account');
		expect(await getAgentRun(accountB, run.id)).toBeNull();
		expect(await getAgentRunSubscriptionState(accountB, run.id)).toBeNull();
		expect(await listKnownAgentRunEvents(accountB, run.id)).toEqual([]);
		await expect(
			createOrGetAgentRun({
				accountId: accountB,
				orgId: run.orgId,
				conversationId: run.conversationId,
				userMessageId: run.userMessageId,
				assistantMessageId: run.assistantMessageId,
				idempotencyKey: 'cross-account-create',
				tenantKey: `tenant-${accountB}`,
				sessionId: 'cross-account-session',
				inputJson: '{}'
			})
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			appendAgentRunEvent(accountB, run.id, 'worker-a', 'wrong', {
				eventType: 'run.started',
				dataJson: '{}',
				workerCursor: 1
			})
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(requestAgentRunCancellation(accountB, run.id)).rejects.toMatchObject({ code: 'not_found' });
	});

	it('rejects stale lease tokens and stale or non-monotonic callbacks', async () => {
		const { run } = await createRun('stale-lease');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a');
		expect(claimed).not.toBeNull();
		await expect(renewAgentRunLease(accountA, run.id, 'worker-a', 'stale-token')).rejects.toMatchObject({
			code: 'stale_lease'
		});
		await expect(
			appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'run.started',
				dataJson: '{}',
				workerCursor: 2
			})
		).rejects.toMatchObject({ code: 'stale_callback' });
		await appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'run.started',
			dataJson: '{}',
			workerCursor: 1
		});
		await expect(
			appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'run.started',
				dataJson: '{}',
				workerCursor: 1
			})
		).resolves.toMatchObject({ event: { cursor: 1 } });
		await expect(
			appendAgentRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'run.started',
				dataJson: JSON.stringify({ different: true }),
				workerCursor: 1
			})
		).rejects.toMatchObject({ code: 'stale_callback' });
	});

	it('permits a cleanup lease after cancellation is requested and rejects claims after finalization', async () => {
		const { run } = await createRun('cancellation');
		const cancelled = await requestAgentRunCancellation(accountA, run.id, 'operator_stop');
		expect(cancelled.state).toBe('cancel_requested');
		expect(cancelled.cancelRequestedAt).toEqual(expect.any(Number));
		expect((await listAgentRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.cancel_requested');
		expect(await claimAgentRunLease(accountA, run.id, 'worker-a')).toMatchObject({ state: 'cancel_requested' });
		const terminal = await finalizeAgentRunCancellation(accountA, run.id);
		expect(terminal).toMatchObject({ state: 'cancelled', completedAt: expect.any(Number) });
		expect(await claimAgentRunLease(accountA, run.id, 'worker-b')).toBeNull();
		expect((await listAgentRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.cancelled');
		await expect(finalizeAgentRunCancellation(accountB, run.id)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('fails an unclaimed queued run after agent start fails', async () => {
		const { run, conversation } = await createRun('start-failure');
		const failed = await failQueuedAgentRun(accountA, run.id);

		expect(failed).toMatchObject({
			state: 'failed',
			errorMessage: 'Research service did not start. Try again.',
			completedAt: expect.any(Number)
		});
		expect((await listAgentRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.failed');
		expect((await getMessages(conversation.id)).at(-1)).toMatchObject({
			role: 'assistant',
			partial: 1
		});
	});

	it('reconciles an expired worker lease after recovery grace once and preserves tenant and lifecycle guards', async () => {
		const { run, conversation, assistant } = await createRun('expired-reconnect');
		const claimed = await claimAgentRunLease(accountA, run.id, 'worker-a', 10_000);
		expect(claimed).not.toBeNull();
		await sql`
			UPDATE agent_runs
			SET lease_expires_at = 9_999
			WHERE id = ${run.id} AND account_id = ${accountA}
		`;

		const reconciledAt = 9_999 + AGENT_RECOVERY_GRACE_MS;
		expect(await reconcileExpiredAgentRun(accountA, run.id, 10_000)).toMatchObject({ state: 'researching', cursor: 0 });
		expect(await reconcileExpiredAgentRun(accountA, run.id, reconciledAt - 1)).toMatchObject({ state: 'researching', cursor: 0 });
		expect(await listAgentRunEvents(accountA, run.id)).toEqual([]);
		const reconciled = await reconcileExpiredAgentRun(accountA, run.id, reconciledAt);
		expect(reconciled).toMatchObject({
			state: 'failed',
			errorMessage: 'Research stopped before it finished. Please try again.',
			cursor: 1,
			leaseOwner: null,
			leaseToken: null,
			leaseExpiresAt: null,
			completedAt: reconciledAt
		});
		expect((await listAgentRunEvents(accountA, run.id)).at(-1)).toMatchObject({
			cursor: 1,
			eventType: 'run.failed',
			dataJson: JSON.stringify({
				failure_class: 'timeout',
				reason: 'worker_lease_expired',
				error: { message: 'Research stopped before it finished. Please try again.' }
			})
		});
		expect((await getMessages(conversation.id)).find((message) => message.id === assistant.id)).toMatchObject({
			partial: 1,
			content: ''
		});
		expect(await reconcileExpiredAgentRun(accountA, run.id, reconciledAt + 1)).toMatchObject({ state: 'failed', cursor: 1 });
		expect(await reconcileExpiredAgentRun(accountB, run.id, reconciledAt + 1)).toBeNull();

		const queued = await createRun('expired-reconnect-queued');
		expect(await reconcileExpiredAgentRun(accountA, queued.run.id, 10_000)).toMatchObject({
			state: 'queued',
			cursor: 0
		});

		const fresh = await createRun('expired-reconnect-fresh');
		const freshClaim = await claimAgentRunLease(accountA, fresh.run.id, 'worker-fresh', 20_000);
		expect(await reconcileExpiredAgentRun(accountA, fresh.run.id, 20_001)).toMatchObject({
			state: 'researching',
			leaseOwner: freshClaim!.leaseOwner,
			cursor: 0
		});

		const renewed = await createRun('expired-reconnect-renewed');
		const renewedClaim = await claimAgentRunLease(accountA, renewed.run.id, 'worker-renewed', 40_000);
		const renewedAt = renewedClaim!.leaseExpiresAt! - 1;
		const renewedRun = await renewAgentRunLease(
			accountA,
			renewed.run.id,
			'worker-renewed',
			renewedClaim!.leaseToken!,
			renewedAt
		);
		expect(await reconcileExpiredAgentRun(accountA, renewed.run.id, renewedClaim!.leaseExpiresAt! + AGENT_RECOVERY_GRACE_MS)).toMatchObject({
			state: 'researching',
			leaseOwner: 'worker-renewed',
			leaseToken: renewedClaim!.leaseToken,
			leaseExpiresAt: renewedRun.leaseExpiresAt,
			cursor: 0
		});

		const replaced = await createRun('expired-reconnect-replaced');
		const firstClaim = await claimAgentRunLease(accountA, replaced.run.id, 'worker-old', 30_000);
		await sql`
			UPDATE agent_runs
			SET lease_expires_at = 29_999
			WHERE id = ${replaced.run.id} AND account_id = ${accountA}
		`;
		const replacement = await claimAgentRunLease(accountA, replaced.run.id, 'worker-new', 30_000);
		expect(replacement?.leaseOwner).toBe('worker-new');
		expect(await reconcileExpiredAgentRun(accountA, replaced.run.id, 29_999 + AGENT_RECOVERY_GRACE_MS)).toMatchObject({
			state: 'researching',
			leaseOwner: 'worker-new',
			leaseToken: replacement!.leaseToken,
			cursor: 0
		});
		expect(firstClaim?.leaseToken).not.toBe(replacement?.leaseToken);

		const cancellation = await createRun('expired-reconnect-cancellation');
		const cancellationClaim = await claimAgentRunLease(accountA, cancellation.run.id, 'worker-cancel', 50_000);
		await requestAgentRunCancellation(accountA, cancellation.run.id, 'browser_stop');
		await sql`
			UPDATE agent_runs
			SET lease_expires_at = 49_999
			WHERE id = ${cancellation.run.id} AND account_id = ${accountA}
		`;
		const cancellationSettledAt = 49_999 + AGENT_RECOVERY_GRACE_MS;
		expect(await reconcileExpiredAgentRun(accountA, cancellation.run.id, cancellationSettledAt - 1)).toMatchObject({
			state: 'cancel_requested', cursor: 1
		});
		expect(await reconcileExpiredAgentRun(accountA, cancellation.run.id, cancellationSettledAt)).toMatchObject({
			state: 'cancelled',
			cursor: 2,
			leaseOwner: null,
			leaseToken: null,
			leaseExpiresAt: null,
			completedAt: cancellationSettledAt
		});
		expect((await listAgentRunEvents(accountA, cancellation.run.id)).at(-1)).toMatchObject({
			cursor: 2,
			eventType: 'run.cancelled',
			dataJson: JSON.stringify({ failure_class: 'cancelled', status: 'cancelled', reason: 'worker_lease_expired' })
		});
		expect(cancellationClaim?.leaseOwner).toBe('worker-cancel');
	});

	it('reclaims queued and expired runs after a worker restart', async () => {
		const queued = await createRun('restart-reclaim-queued');
		const firstClaim = await claimAgentRunLease(accountA, queued.run.id, 'old-worker', 1000);
		expect(firstClaim).not.toBeNull();
		const released = await releaseAgentRunLease(accountA, queued.run.id, 'old-worker', firstClaim!.leaseToken!);
		expect(released).toMatchObject({ state: 'queued', leaseOwner: null, leaseToken: null });
		const reclaimed = await reclaimQueuedOrExpiredAgentRuns('new-worker', 10, 1000 + AGENT_LEASE_MS + 1);
		expect(reclaimed.map((run) => run.id)).toContain(queued.run.id);
		expect(reclaimed.find((run) => run.id === queued.run.id)).toMatchObject({
			leaseOwner: 'new-worker',
			state: 'researching'
		});
		expect(reclaimed.find((run) => run.id === queued.run.id)?.leaseToken).not.toBe(firstClaim?.leaseToken);

		const active = await getActiveAgentRun(accountA, queued.conversation.id);
		expect(active?.id).toBe(queued.run.id);
	});

	it('selects recovery candidates fairly across tenant backlogs', async () => {
		const noisyOne = await createRun('fair-noisy-one', accountA, 'tenant-noisy');
		const quiet = await createRun('fair-quiet-one', accountB, 'tenant-quiet');
		const noisyTwo = await createRun('fair-noisy-two', accountA, 'tenant-noisy');
		const noisyThree = await createRun('fair-noisy-three', accountA, 'tenant-noisy');

		const claimed = await reclaimQueuedOrExpiredAgentRuns('fair-worker', 50, Date.now());
		const claimedIds = claimed.map((run) => run.id);
		expect(claimedIds).toContain(noisyOne.run.id);
		expect(claimedIds).toContain(quiet.run.id);
		expect(claimedIds).toContain(noisyTwo.run.id);
		expect(claimedIds).toContain(noisyThree.run.id);
		expect(claimedIds.indexOf(quiet.run.id)).toBeLessThan(claimedIds.indexOf(noisyTwo.run.id));
		expect(claimedIds.indexOf(quiet.run.id)).toBeLessThan(claimedIds.indexOf(noisyThree.run.id));

		for (const run of claimed) {
			await releaseAgentRunLease(run.accountId, run.id, 'fair-worker', run.leaseToken!);
		}
	});
});
