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
	HERMES_LEASE_MS,
	appendHermesRunEvent,
	claimHermesRunLease,
	createOrGetHermesRun,
	failQueuedHermesRun,
	finalizeHermesRunCancellation,
	getActiveHermesRun,
	getHermesRun,
	getHermesRunForAssistant,
	getHermesRunSubscriptionState,
	listHermesRunEvents,
	listKnownHermesRunEvents,
	reclaimQueuedOrExpiredHermesRuns,
	renewHermesRunLease,
	releaseHermesRunLease,
	requestHermesRunCancellation,
} from './hermes-runs';
import { getMessageProvenance } from './message-provenance';

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

	async function seed(operation: string, accountId = accountA) {
		const conversation = await createConversation(accountId);
		const user = await addMessage({ conversationId: conversation.id, role: 'user', content: 'Research this.' });
		const assistant = await addMessage({ conversationId: conversation.id, role: 'assistant', content: '', partial: true });
		const idempotencyKey = `${operation}-${conversation.id}`;
		return { conversation, user, assistant, idempotencyKey };
	}

	async function createRun(operation: string, accountId = accountA, tenantKey = `tenant-${accountId}`) {
		const seeded = await seed(operation, accountId);
		const result = await createOrGetHermesRun({
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
			createOrGetHermesRun({ ...runInput, preparedClaimToken: prepared.claimToken })
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
		const claimed = await createOrGetHermesRun({
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
		const original = await createOrGetHermesRun({
			...base,
			idempotencyKey: 'resume-original',
			seededCitationsJson: '[]'
		});

		const [firstResume, secondResume] = await Promise.all([
			createOrGetHermesRun({ ...base, idempotencyKey: 'resume-browser-a' }),
			createOrGetHermesRun({ ...base, idempotencyKey: 'resume-browser-b' })
		]);

		expect(firstResume.created).toBe(false);
		expect(secondResume.created).toBe(false);
		expect(firstResume.run.id).toBe(original.run.id);
		expect(secondResume.run.id).toBe(original.run.id);
		expect((await getHermesRunForAssistant(accountA, seeded.conversation.id, seeded.assistant.id))?.id).toBe(
			original.run.id
		);
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
		const { run } = await createOrGetHermesRun({
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
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		const source = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'agent.source.read',
			dataJson: JSON.stringify({ source: { id: 'source-1', url: citation.url, title: citation.title } }),
			workerCursor: 1
		});
		expect(JSON.parse(source.run.sourcesJson)).toEqual([
			{ id: 'source-1', url: citation.url, title: citation.title }
		]);

		const withCitation = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'agent.citations',
			dataJson: JSON.stringify({ citations: [citation] }),
			workerCursor: 2
		});
		expect(JSON.parse(withCitation.run.citationsJson)).toEqual([citation]);
		const metadataAfterCitation = (await getMessages(seeded.conversation.id)).find(
			(message) => message.id === seeded.assistant.id
		)?.toolCalls;
		expect(metadataAfterCitation).toContain('Primary source');

		const withTool = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
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

		const withText = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
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

		const terminal = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
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
		expect((await listHermesRunEvents(accountA, run.id)).map((event) => event.eventType)).toEqual([
			'agent.source.read',
			'agent.citations',
			'agent.tool.progress',
			'response.output_text.delta',
			'response.completed'
		]);
	});

	it('serializes concurrent callbacks under the run row lock', async () => {
		const { run } = await createRun('concurrent-callbacks');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		const results = await Promise.allSettled([
			appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'one' }),
				workerCursor: 1
			}),
			appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'two' }),
				workerCursor: 1
			})
		]);

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		const rejected = results.find((result) => result.status === 'rejected');
		expect(rejected).toMatchObject({ reason: { code: 'stale_callback' } });
		expect((await listHermesRunEvents(accountA, run.id)).map((event) => event.cursor)).toEqual([1]);
		expect((await getHermesRun(accountA, run.id))?.workerCursor).toBe(1);
	});

	it('rolls back the event and run snapshot when a durable message write fails', async () => {
		const { run, conversation, assistant } = await createRun('callback-rollback');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		await sql`
			CREATE FUNCTION hermes_item6_fail_message_update() RETURNS trigger
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
			CREATE TRIGGER hermes_item6_fail_message_update
			BEFORE UPDATE OF content ON messages
			FOR EACH ROW EXECUTE FUNCTION hermes_item6_fail_message_update()
		`;
		try {
			await expect(
				appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
					eventType: 'response.output_text.delta',
					dataJson: JSON.stringify({ delta: 'ROLLBACK_MARKER' }),
					workerCursor: 1
				})
			).rejects.toThrow('Failed query: update "messages"');
		} finally {
			await sql`DROP TRIGGER IF EXISTS hermes_item6_fail_message_update ON messages`;
			await sql`DROP FUNCTION IF EXISTS hermes_item6_fail_message_update()`;
		}

		expect(await getHermesRun(accountA, run.id)).toMatchObject({
			cursor: 0,
			workerCursor: 0,
			state: 'researching',
			answerText: ''
		});
		expect(await listHermesRunEvents(accountA, run.id)).toEqual([]);
		expect((await getMessages(conversation.id)).find((message) => message.id === assistant.id)).toMatchObject({
			content: '',
			partial: 1
		});
	});

	it('rejects an expired lease before writing a callback event', async () => {
		const { run } = await createRun('expired-callback-lease');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		await sql`UPDATE hermes_runs SET lease_expires_at = 0 WHERE id = ${run.id} AND account_id = ${accountA}`;

		await expect(
			appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'expired' }),
				workerCursor: 1
			})
		).rejects.toMatchObject({ code: 'stale_lease' });
		expect(await listHermesRunEvents(accountA, run.id)).toEqual([]);
		expect((await getHermesRun(accountA, run.id))?.cursor).toBe(0);
	});

	it('returns a current reconnect snapshot and only newer events', async () => {
		const { run } = await createRun('reconnect-snapshot');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'Before reconnect.' }),
			workerCursor: 1
		});
		const snapshot = await getHermesRunSubscriptionState(accountA, run.id);
		expect(snapshot).toMatchObject({ state: 'writing', cursor: 1 });
		expect(await listKnownHermesRunEvents(accountA, run.id, snapshot!.cursor)).toEqual([]);

		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: ' After reconnect.' }),
			workerCursor: 2
		});
		expect(await listKnownHermesRunEvents(accountA, run.id, snapshot!.cursor)).toMatchObject([
			{ cursor: 2, eventType: 'response.output_text.delta' }
		]);
	});

	it('omits unchanged snapshot and message metadata fields on text callbacks', async () => {
		const { run } = await createRun('text-update-shape');
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'run.started',
			dataJson: '{}',
			workerCursor: 1
		});
		const options = (sql as any).options;
		const previousDebug = options.debug;
		const queries: string[] = [];
		options.debug = (_connectionId: number, query: string) => queries.push(query);
		try {
			await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'response.output_text.delta',
				dataJson: JSON.stringify({ delta: 'Only text changes.' }),
				workerCursor: 2
			});
		} finally {
			options.debug = previousDebug;
		}

		const runSelects = queries.filter((query) => /select[\s\S]+from "hermes_runs"/i.test(query));
		const runUpdate = queries.find((query) => /update "hermes_runs"/i.test(query));
		const messageUpdate = queries.find((query) => /update "messages"/i.test(query));
		expect(runSelects).toHaveLength(1);
		expect(runSelects[0]).toMatch(/for update/i);
		expect(runUpdate).toBeDefined();
		expect(runUpdate?.split(' returning ')[0]).not.toMatch(/sources_json|citations_json|tools_json/i);
		expect(messageUpdate).toBeDefined();
		expect(messageUpdate).not.toMatch(/tool_calls/i);
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
		const { run } = await createOrGetHermesRun({
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
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'The prior source supports this [3].' }),
			workerCursor: 1
		});
		const final = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
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
		const claimed = await claimHermesRunLease(accountA, run.id, 'worker-a');
		await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
			eventType: 'response.output_text.delta',
			dataJson: JSON.stringify({ delta: 'This claim has no saved source [3].' }),
			workerCursor: 1
		});
		const final = await appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
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
		expect(await getHermesRun(accountB, run.id)).toBeNull();
		expect(await getHermesRunSubscriptionState(accountB, run.id)).toBeNull();
		expect(await listKnownHermesRunEvents(accountB, run.id)).toEqual([]);
		await expect(
			createOrGetHermesRun({
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
		).resolves.toMatchObject({ event: { cursor: 1 } });
		await expect(
			appendHermesRunEvent(accountA, run.id, 'worker-a', claimed!.leaseToken!, {
				eventType: 'run.started',
				dataJson: JSON.stringify({ different: true }),
				workerCursor: 1
			})
		).rejects.toMatchObject({ code: 'stale_callback' });
	});

	it('records cancellation and does not allow a cancelled run to be claimed', async () => {
		const { run } = await createRun('cancellation');
		const cancelled = await requestHermesRunCancellation(accountA, run.id, 'operator_stop');
		expect(cancelled.state).toBe('cancel_requested');
		expect(cancelled.cancelRequestedAt).toEqual(expect.any(Number));
		expect((await listHermesRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.cancel_requested');
		expect(await claimHermesRunLease(accountA, run.id, 'worker-a')).toBeNull();
		const terminal = await finalizeHermesRunCancellation(accountA, run.id);
		expect(terminal).toMatchObject({ state: 'cancelled', completedAt: expect.any(Number) });
		expect((await listHermesRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.cancelled');
		await expect(finalizeHermesRunCancellation(accountB, run.id)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('fails an unclaimed queued run after Hermes start fails', async () => {
		const { run, conversation } = await createRun('start-failure');
		const failed = await failQueuedHermesRun(accountA, run.id);

		expect(failed).toMatchObject({
			state: 'failed',
			errorMessage: 'Research service did not start. Try again.',
			completedAt: expect.any(Number)
		});
		expect((await listHermesRunEvents(accountA, run.id)).at(-1)?.eventType).toBe('run.failed');
		expect((await getMessages(conversation.id)).at(-1)).toMatchObject({
			role: 'assistant',
			partial: 1
		});
	});

	it('reclaims queued and expired runs after a worker restart', async () => {
		const queued = await createRun('restart-reclaim-queued');
		const firstClaim = await claimHermesRunLease(accountA, queued.run.id, 'old-worker', 1000);
		expect(firstClaim).not.toBeNull();
		const released = await releaseHermesRunLease(accountA, queued.run.id, 'old-worker', firstClaim!.leaseToken!);
		expect(released).toMatchObject({ state: 'queued', leaseOwner: null, leaseToken: null });
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

	it('selects recovery candidates fairly across tenant backlogs', async () => {
		const noisyOne = await createRun('fair-noisy-one', accountA, 'tenant-noisy');
		const quiet = await createRun('fair-quiet-one', accountB, 'tenant-quiet');
		const noisyTwo = await createRun('fair-noisy-two', accountA, 'tenant-noisy');
		const noisyThree = await createRun('fair-noisy-three', accountA, 'tenant-noisy');

		const claimed = await reclaimQueuedOrExpiredHermesRuns('fair-worker', 50, Date.now());
		const claimedIds = claimed.map((run) => run.id);
		expect(claimedIds).toContain(noisyOne.run.id);
		expect(claimedIds).toContain(quiet.run.id);
		expect(claimedIds).toContain(noisyTwo.run.id);
		expect(claimedIds).toContain(noisyThree.run.id);
		expect(claimedIds.indexOf(quiet.run.id)).toBeLessThan(claimedIds.indexOf(noisyTwo.run.id));
		expect(claimedIds.indexOf(quiet.run.id)).toBeLessThan(claimedIds.indexOf(noisyThree.run.id));

		for (const run of claimed) {
			await releaseHermesRunLease(run.accountId, run.id, 'fair-worker', run.leaseToken!);
		}
	});
});
