import type { Cookies } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresAuth } from '../auth/postgres';
import { SESSION_COOKIE_NAME } from '../auth/cookie';
import { ensureMigrated, sql } from './index';
import { createConversation, addMessage, getConversation } from './conversations';
import { runtimeCheckpoint, type RuntimeBinding } from './agent-runtime';
import {
  createOrGetHermesRun, claimHermesRunLease, releaseHermesRunLease,
  requestHermesRunCancellation, appendHermesRunEvent, listHermesRunEvents
} from './hermes-runs';

function cookieJar() {
  const values = new Map<string, string>();
  return {
    values,
    cookies: {
      get: (name: string) => values.get(name),
      set: (name: string, value: string) => values.set(name, value),
      delete: (name: string) => values.delete(name)
    } as unknown as Cookies
  };
}

describe.skipIf(!process.env.NEWSCRAFT_TEST_DATABASE_URL)('owned agent core against isolated Postgres', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const left = cookieJar();
  const right = cookieJar();
  const password = 'public-synthetic-fixture-password';
  let accountA: string;
  let accountB: string;

  beforeAll(async () => {
    await ensureMigrated();
    await postgresAuth.signUp({ email: `core-a-${suffix}@example.test`, name: 'Fixture A', password }, left.cookies, 'http://127.0.0.1');
    await postgresAuth.signUp({ email: `core-b-${suffix}@example.test`, name: 'Fixture B', password }, right.cookies, 'http://127.0.0.1');
    accountA = (await postgresAuth.authenticate(left.cookies))!.id;
    accountB = (await postgresAuth.authenticate(right.cookies))!.id;
  });

  afterAll(async () => {
    if (accountA) await sql`DELETE FROM accounts WHERE id = ${accountA}`;
    if (accountB) await sql`DELETE FROM accounts WHERE id = ${accountB}`;
    await sql.end({ timeout: 1 });
  });

  async function running() {
    const conversation = await createConversation(accountA);
    const user = await addMessage({ conversationId: conversation.id, role: 'user', content: 'Synthetic research.' });
    const assistant = await addMessage({ conversationId: conversation.id, role: 'assistant', content: '', partial: true });
    const { run } = await createOrGetHermesRun({ accountId: accountA, orgId: conversation.orgId,
      conversationId: conversation.id, userMessageId: user.id, assistantMessageId: assistant.id,
      idempotencyKey: conversation.id, tenantKey: `tenant-${accountA}`, sessionId: 'synthetic-session', inputJson: '{}' });
    const lease = (await claimHermesRunLease(accountA, run.id, 'fixture-worker'))!;
    const binding: RuntimeBinding = { accountId: accountA, runId: run.id, tenantKey: run.tenantKey,
      leaseOwner: lease.leaseOwner!, leaseToken: lease.leaseToken! };
    return { run, binding };
  }

  it('creates independent member accounts, private organizations, conversations and revocable sessions', async () => {
    expect((await postgresAuth.authenticate(left.cookies))?.role).toBe('member');
    expect((await postgresAuth.authenticate(right.cookies))?.role).toBe('member');
    const conversation = await createConversation(accountA);
    expect(conversation.orgId).toBe(`org_${accountA}`);
    expect((await getConversation(accountA, conversation.id))?.id).toBe(conversation.id);
    expect(await getConversation(accountB, conversation.id)).toBeUndefined();
    const memberships = await sql`SELECT org_id, account_id FROM organization_members WHERE account_id IN (${accountA}, ${accountB})`;
    expect(memberships.map(row => [row.account_id, row.org_id]).sort()).toEqual([
      [accountA, `org_${accountA}`], [accountB, `org_${accountB}`]
    ].sort());
    const old = left.values.get(SESSION_COOKIE_NAME)!;
    await postgresAuth.signOut(left.cookies);
    left.values.set(SESSION_COOKIE_NAME, old);
    expect(await postgresAuth.authenticate(left.cookies)).toBeNull();
    await expect(postgresAuth.signIn(`core-a-${suffix}@example.test`, 'wrong', left.cookies)).rejects.toMatchObject({ status: 401 });
    await postgresAuth.signIn(`core-a-${suffix}@example.test`, password, left.cookies);
    expect((await postgresAuth.authenticate(left.cookies))?.id).toBe(accountA);
  });

  it('replays a committed checkpoint once, serializes conflicting updates and never exposes private continuation in events', async () => {
    const { run, binding } = await running();
    const first = { version: 0, state: { phase: 'running', private: { continuation: 'PRIVATE_SYNTHETIC_CIPHER' } } };
    expect(await runtimeCheckpoint(binding, first, true)).toMatchObject({ version: 1 });
    expect(await runtimeCheckpoint(binding, first, true)).toMatchObject({ version: 1 });
    const results = await Promise.allSettled([
      runtimeCheckpoint(binding, { version: 1, state: { step: 'a' } }, true),
      runtimeCheckpoint(binding, { version: 1, state: { step: 'b' } }, true)
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'stale_callback' } });
    await appendHermesRunEvent(accountA, run.id, binding.leaseOwner, binding.leaseToken,
      { workerCursor: 1, eventType: 'agent.decision', dataJson: JSON.stringify({ id: 'check', summary: 'I checked the source.' }) });
    expect(JSON.stringify(await listHermesRunEvents(accountA, run.id))).not.toContain('PRIVATE_SYNTHETIC_CIPHER');
    await expect(runtimeCheckpoint({ ...binding, accountId: accountB })).rejects.toMatchObject({ code: 'not_found' });
    await expect(runtimeCheckpoint({ ...binding, tenantKey: 'other-tenant' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fences expired owners and cancellation while retaining checkpoint access for cleanup', async () => {
    const { run, binding } = await running();
    await runtimeCheckpoint(binding, { version: 0, state: { intent: 'synthetic-tool' } }, true);
    await releaseHermesRunLease(accountA, run.id, binding.leaseOwner, binding.leaseToken);
    const lease = (await claimHermesRunLease(accountA, run.id, 'replacement-worker'))!;
    const current = { ...binding, leaseOwner: lease.leaseOwner!, leaseToken: lease.leaseToken! };
    await expect(runtimeCheckpoint(binding)).rejects.toMatchObject({ code: 'stale_lease' });
    expect(await runtimeCheckpoint(current)).toMatchObject({ version: 1, state: { intent: 'synthetic-tool' } });
    await requestHermesRunCancellation(accountA, run.id);
    await expect(runtimeCheckpoint(current, { version: 1, state: { intent: 'new-tool' } }, true)).rejects.toMatchObject({ code: 'cancel_requested' });
    expect(await runtimeCheckpoint(current, { version: 1, state: { phase: 'cancelled' } })).toMatchObject({ version: 2 });
  });
});
