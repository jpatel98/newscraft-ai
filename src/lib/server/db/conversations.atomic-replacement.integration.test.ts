import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as chatStream } from '../../../routes/api/chat/stream/+server';
import { GET as exportConversation } from '../../../routes/api/conversations/[id]/export/+server';
import { POST as claimPartial } from '../../../routes/api/messages/[id]/claim-partial/+server';
import { POST as clearPartial } from '../../../routes/api/messages/[id]/clear-partial/+server';
import * as agentTransport from '../agent/transport';
import { ensureMigrated, sql } from './index';
import { claimPartialAssistantMessage, finalizeResumedAssistantMessage, getMessages, getMessageById, parseContent } from './conversations';
import { getMessageProvenance } from './message-provenance';
import { appendHermesRunEvents, claimHermesRunLease, getHermesRun, listHermesRunEvents, type HermesRunEventInput } from './hermes-runs';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

describe.skipIf(!databaseUrl)('durable assistant replacement and SQL claim integration', () => {
	const accountId = `atomic-test-account-${Date.now()}`;
	const originalConfig = {
		url: process.env.NEWSCRAFT_AGENT_URL,
		token: process.env.NEWSCRAFT_AGENT_API_TOKEN,
		tenant: process.env.NEWSCRAFT_AGENT_TENANT_SECRET
	};
	const startDurableRunSpy = vi.spyOn(agentTransport, 'startDurableHermesRun');
	let callbackEvents: Array<Omit<HermesRunEventInput, 'workerCursor'>> = [];
	let lastRunId = '';

	beforeAll(async () => {
		process.env.NEWSCRAFT_AGENT_URL = 'http://agent.test';
		process.env.NEWSCRAFT_AGENT_API_TOKEN = 'test-agent-token';
		process.env.NEWSCRAFT_AGENT_TENANT_SECRET = 'test-tenant-secret-0123456789012345';
		startDurableRunSpy.mockImplementation(async request => {
			lastRunId = request.runId;
			const saved = await getHermesRun(request.accountId, request.runId);
			if (!saved || saved.tenantKey !== request.tenantKey) throw new Error('fixture tenant binding mismatch');
			const lease = await claimHermesRunLease(request.accountId, request.runId, 'fixture-worker');
			if (!lease?.leaseToken || !lease.leaseOwner) throw new Error('fixture could not claim the run');
			const events = [{ eventType: 'run.started', dataJson: '{}' }, ...callbackEvents]
				.map((event, index) => ({ ...event, workerCursor: lease.workerCursor + index + 1 }));
			await appendHermesRunEvents(request.accountId, request.runId, lease.leaseOwner, lease.leaseToken, events);
		});
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('durable database fixtures never call external APIs'); }));
		await ensureMigrated();
		const now = Date.now();
		await sql`INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES (${accountId}, ${`${accountId}@example.test`}, 'Atomic test', 'member', ${now}, ${now})`;
	});

	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${accountId}`;
		await sql.end({ timeout: 1 });
		for (const [key, value] of [
			['NEWSCRAFT_AGENT_URL', originalConfig.url], ['NEWSCRAFT_AGENT_API_TOKEN', originalConfig.token],
			['NEWSCRAFT_AGENT_TENANT_SECRET', originalConfig.tenant]
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.unstubAllGlobals();
		startDurableRunSpy.mockRestore();
	});

	function workerEvents(frames: Array<[string, Record<string, unknown>]>, terminal = 'response.completed') {
		callbackEvents = frames.map(([eventType, data]) => ({ eventType, dataJson: JSON.stringify(data) }));
		callbackEvents.push({ eventType: terminal, dataJson: '{}' });
	}
	const citations = { citations: [{ citationNumber: 1, title: 'Authoritative fixture source',
		url: 'https://fixture.example/source', domain: 'fixture.example', publicationDate: '2026-09-01',
		sourceType: 'official', supportingExcerpt: 'Authoritative fixture claim.' }] };

	it('resumes through durable callbacks without a mode header and persists one cited answer for reload and export', async () => {
		const scenario = await seedPartial('replacement');
		const authoritative = 'Authoritative replacement with complete citation [1].';
		workerEvents([['agent.citations', citations], ['agent.answer.replace', { content: authoritative }]]);
		const response = await invokeResume(scenario);
		const streamed = await response.text();
		expect(streamed).toContain('event: run.snapshot');
		expect(streamed).toContain(authoritative);
		await assertAuthoritative(scenario.conversationId, scenario.messageId, authoritative);
		await expectExport(scenario.conversationId, authoritative);
		await expect(invokeResume(scenario)).rejects.toMatchObject({ status: 400 });
	});

	it('persists a bounded large complete replacement', async () => {
		const scenario = await seedPartial('large-safe-replacement');
		const authoritative = 's'.repeat(96_000);
		workerEvents([['agent.answer.replace', { content: authoritative }]]);
		await (await invokeResume(scenario)).text();
		await assertAuthoritative(scenario.conversationId, scenario.messageId, authoritative);
		await expectExport(scenario.conversationId, authoritative);
	});

	it('removes unsupported citation markers from durable snapshots, reload and export', async () => {
		const scenario = await seedPartial('provider-markers');
		workerEvents([['agent.answer.replace', { content: 'Confirmed facts [99] and malformed [1.' }]]);
		await (await invokeResume(scenario)).text();
		await assertAuthoritative(scenario.conversationId, scenario.messageId, 'Confirmed facts and malformed.');
		await expectExport(scenario.conversationId, 'Confirmed facts and malformed.');
	});

	it('records an authoritative replacement and every later delta exactly once despite a replayed callback', async () => {
		const scenario = await seedPartial('replacement-tail');
		const authoritative = 'Authoritative answer [1].';
		workerEvents([['agent.citations', citations], ['agent.answer.replace', { content: authoritative }],
			['response.output_text.delta', { delta: ' Tail one.' }], ['response.output_text.delta', { delta: ' Tail two.' }]]);
		await (await invokeResume(scenario)).text();
		const saved = (await getHermesRun(accountId, lastRunId))!;
		const events = [{ eventType: 'run.started', dataJson: '{}' }, ...callbackEvents]
			.map((event, index) => ({ ...event, workerCursor: index + 1 }));
		await appendHermesRunEvents(accountId, saved.id, saved.leaseOwner!, saved.leaseToken!, events);
		expect(await listHermesRunEvents(accountId, saved.id)).toHaveLength(events.length);
		await assertAuthoritative(scenario.conversationId, scenario.messageId, `${authoritative} Tail one. Tail two.`);
		await expectExport(scenario.conversationId, `${authoritative} Tail one. Tail two.`);
	});

	it('keeps a cancelled answer partial and permits a fresh durable resume', async () => {
		const scenario = await seedPartial('cancelled');
		workerEvents([['agent.answer.replace', { content: 'Recorded partial answer.' }]], 'run.cancelled');
		await (await invokeResume(scenario)).text();
		const cancelledRunId = lastRunId;
		expect(await getMessageById(scenario.messageId)).toMatchObject({ partial: 1, resumeClaimedAt: null, content: 'Recorded partial answer.' });
		workerEvents([['agent.answer.replace', { content: 'Recovered complete answer.' }]]);
		await (await invokeResume(scenario)).text();
		expect(lastRunId).not.toBe(cancelledRunId);
		await assertAuthoritative(scenario.conversationId, scenario.messageId, 'Recovered complete answer.');
	});

	it('preserves a saved partial answer through worker startup failure and resumes it again', async () => {
		const scenario = await seedPartial('startup-failure');
		startDurableRunSpy.mockRejectedValueOnce(new Error('fixture worker unavailable'));
		const response = await invokeResume(scenario);
		expect(await response.text()).toContain('"status":"failed"');
		expect(await getMessageById(scenario.messageId)).toMatchObject({
			partial: 1, resumeClaimedAt: null, content: 'Partial draft for startup-failure.'
		});
		workerEvents([['agent.answer.replace', { content: 'Recovered complete answer.' }]]);
		await (await invokeResume(scenario)).text();
		await assertAuthoritative(scenario.conversationId, scenario.messageId, 'Recovered complete answer.');
	});

	it('rejects a stale CAS owner without changing content or provenance', async () => {
		const scenario = await seedPartial('cas');
		const claimToken = await claimPartialAssistantMessage(scenario.messageId, scenario.conversationId);
		expect(claimToken).toEqual(expect.any(Number));
		await expect(invokeResume(scenario)).rejects.toMatchObject({ status: 409 });

		const stale = await finalizeResumedAssistantMessage({
			id: scenario.messageId,
			conversationId: scenario.conversationId,
			claimToken: (claimToken as number) + 1,
			mode: 'replace',
			content: 'Stale replacement must not commit.',
			toolCalls: null,
			provenanceJson: JSON.stringify({ stream: { answerText: 'stale' } }),
			partial: 0
		});
		expect(stale).toBeUndefined();
		const unchanged = await getMessageById(scenario.messageId);
		expect(unchanged).toMatchObject({
			content: 'Partial draft for cas.',
			partial: 1,
			resumeClaimedAt: claimToken
		});

		const committed = await finalizeResumedAssistantMessage({
			id: scenario.messageId,
			conversationId: scenario.conversationId,
			claimToken: claimToken as number,
			mode: 'replace',
			content: 'CAS owner replacement.',
			toolCalls: null,
			provenanceJson: JSON.stringify({ stream: { answerText: 'CAS owner replacement.' } }),
			partial: 0
		});
		expect(committed).toMatchObject({ content: 'CAS owner replacement.', partial: 0, resumeClaimedAt: null });
		await expectExport(scenario.conversationId, 'CAS owner replacement.');
	});

	it('discards only the active partial owner and rejects stale or duplicate discard attempts', async () => {
		const active = await seedPartial('discard-active');
		const activeToken = await invokeClaim(active);
		expect(activeToken).toEqual(expect.any(Number));
		expect(await getMessageById(active.messageId)).toMatchObject({ partial: 1, resumeClaimedAt: activeToken });
		const discarded = await invokeDiscard(active, activeToken as number);
		expect(discarded.status).toBe(200);
		await discarded.text();
		const discardedRow = await getMessageById(active.messageId);
		expect(discardedRow).toMatchObject({ partial: 0, resumeClaimedAt: null });
		await assertProvenance(active.messageId);
		await expectExport(active.conversationId, 'Partial draft for discard-active.');

		await expect(invokeDiscard(active, activeToken as number)).rejects.toMatchObject({ status: 409 });

		const stale = await seedPartial('discard-stale');
		const ownerToken = await invokeClaim(stale);
		expect(ownerToken).toEqual(expect.any(Number));
		await expect(invokeDiscard(stale, (ownerToken as number) + 1)).rejects.toMatchObject({ status: 409 });
		expect(await getMessageById(stale.messageId)).toMatchObject({
			partial: 1,
			resumeClaimedAt: ownerToken
		});
		const ownerDiscard = await invokeDiscard(stale, ownerToken as number);
		expect(ownerDiscard.status).toBe(200);
		await ownerDiscard.text();
		await expectExport(stale.conversationId, 'Partial draft for discard-stale.');
	});

	async function seedPartial(label: string): Promise<{ conversationId: string; messageId: string }> {
		const conversationId = `atomic-test-conversation-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const messageId = `atomic-test-message-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();
		await sql`
			INSERT INTO conversations (id, account_id, org_id, title, created_at, updated_at, pinned)
			VALUES (${conversationId}, ${accountId}, 'org_default', ${`Atomic ${label}`}, ${now}, ${now}, 0)
		`;
		await sql`
			INSERT INTO messages (id, conversation_id, role, content, tool_calls, partial, resume_claimed_at, created_at)
			VALUES (${`user-${messageId}`}, ${conversationId}, 'user', ${`Continue the ${label} answer.`}, NULL, 0, NULL, ${now + 1})
		`;
		await sql`
			INSERT INTO messages (id, conversation_id, role, content, tool_calls, partial, resume_claimed_at, created_at)
			VALUES (${messageId}, ${conversationId}, 'assistant', ${`Partial draft for ${label}.`}, 'old-metadata', 1, NULL, ${now + 2})
		`;
		return { conversationId, messageId };
	}

	async function invokeResume(scenario: { conversationId: string; messageId: string }): Promise<Response> {
		return chatStream({
			request: new Request('http://localhost/api/chat/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					conversation_id: scenario.conversationId,
					resume: true,
					message_id: scenario.messageId,
					trace_id: `integration-${Date.now()}`
				})
			}),
			locals: { user: { id: accountId } },
			getClientAddress: () => '127.0.0.1'
		} as never);
	}

	async function invokeDiscard(
		scenario: { conversationId: string; messageId: string },
		claimToken: number
	): Promise<Response> {
		return clearPartial({
			request: new Request(`http://localhost/api/messages/${scenario.messageId}/clear-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: scenario.conversationId, claim_token: claimToken })
			}),
			params: { id: scenario.messageId },
			locals: { user: { id: accountId } }
		} as never);
	}

	async function invokeClaim(scenario: { conversationId: string; messageId: string }): Promise<number> {
		const response = await claimPartial({
			request: new Request(`http://localhost/api/messages/${scenario.messageId}/claim-partial`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ conversation_id: scenario.conversationId })
			}),
			params: { id: scenario.messageId },
			locals: { user: { id: accountId } }
		} as never);
		expect(response.status).toBe(200);
		return ((await response.json()) as { claim_token: number }).claim_token;
	}

	async function assertAuthoritative(conversationId: string, messageId: string, expected: string): Promise<void> {
		const messages = await getMessages(conversationId);
		expect(messages).toHaveLength(2);
		const row = messages.find((message) => message.id === messageId);
		expect(row).toMatchObject({ content: expected, partial: 0, resumeClaimedAt: null });
		expect(parseContent(row?.content || '')).toBe(expected);
		await assertProvenance(messageId);
	}

	async function assertProvenance(messageId: string): Promise<void> {
		const row = await getMessageProvenance(messageId);
		expect(row).toBeDefined();
		const rows = await sql`SELECT message_id FROM message_provenance WHERE message_id = ${messageId}`;
		expect(rows).toHaveLength(1);
		const parsed = JSON.parse(row?.provenanceJson || '{}') as {
			stream?: { assistantChars?: number; done?: boolean };
		};
		expect(parsed.stream?.assistantChars).toBeGreaterThan(0);
	}

	async function expectExport(conversationId: string, expected: string): Promise<void> {
		const response = await exportConversation({
			params: { id: conversationId },
			url: new URL(`http://localhost/api/conversations/${conversationId}/export?format=jsonl`),
			locals: { user: { id: accountId } }
		} as never);
		const messages = (await response.text())
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((line) => line.type === 'message');
		expect(messages).toHaveLength(2);
		expect(messages.find((line) => line.role === 'assistant')?.content).toBe(expected);
		const markdown = await exportConversation({
			params: { id: conversationId },
			url: new URL(`http://localhost/api/conversations/${conversationId}/export?format=md`),
			locals: { user: { id: accountId } }
		} as never);
		expect(await markdown.text()).toContain(expected);
	}
});
