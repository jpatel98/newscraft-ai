import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('./index', () => ({ db: database }));
import { managedCheckpoint } from './managed-agent';
const binding = { accountId: 'account-one', runId: 'run-one', tenantKey: 'tenant-one', leaseOwner: 'worker-one', leaseToken: 'lease-one' };
function transaction({ owner = true, account = 'account-one', phase = 'finished', active = 'run-one', lease = 'lease-one', expires = Date.now() + 60000 } = {}) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (statement: any) => {
        const query = new PgDialect().sqlToQuery(statement); queries.push(query);
        if (query.sql.includes('SELECT * FROM hermes_runs')) return [{ tenant_key: 'tenant-one', lease_owner: 'worker-one', lease_token: lease, lease_expires_at: expires, conversation_id: 'conversation-one' }];
        if (query.sql.includes('SELECT id FROM conversations')) return owner ? [{ id: 'conversation-one' }] : [];
        if (query.sql.includes('SELECT * FROM managed_agent_sessions')) return [{ account_id: account, active_run_id: active, session_id: 'sess_one', state_json: JSON.stringify({ session_id: 'sess_one', phase }), version: 3 }];
        return [];
    });
    database.transaction.mockImplementation(operation => operation({ execute }));
    return queries;
}
describe('managed provider state fencing', () => {
    beforeEach(() => vi.clearAllMocks());
    it('binds reads to account, conversation, tenant and active lease', async () => {
        const queries = transaction();
        expect(await managedCheckpoint(binding)).toMatchObject({ version: 3, state: { session_id: 'sess_one' } });
        expect(queries[0].params).toEqual(['run-one', 'account-one']);
        expect(queries[1].params).toEqual(['conversation-one', 'account-one']);
    });
    it.each([{ owner: false }, { account: 'account-other' }])('rejects cross-user state before mutation: %j', async options => {
        const queries = transaction(options);
        await expect(managedCheckpoint(binding)).rejects.toMatchObject({ code: 'not_found' });
        expect(queries.every(query => query.sql.trim().startsWith('SELECT'))).toBe(true);
    });
    it.each([{ lease: 'stale' }, { expires: 1 }])('rejects expired or replaced leases: %j', async options => {
        const queries = transaction(options);
        await expect(managedCheckpoint(binding)).rejects.toMatchObject({ code: 'stale_lease' });
        expect(queries).toHaveLength(1);
    });
    it('blocks the next run while provider cancellation is pending, then reuses the session after confirmation', async () => {
        transaction({ active: 'previous-run', phase: 'cancel_pending' });
        await expect(managedCheckpoint(binding)).rejects.toMatchObject({ code: 'stale_callback' });
        transaction({ active: 'previous-run', phase: 'cancelled' });
        expect(await managedCheckpoint(binding)).toEqual({ version: 4, state: { session_id: 'sess_one' } });
    });
    it('rejects a provider session substitution and stale state version', async () => {
        transaction();
        await expect(managedCheckpoint(binding, { version: 3, state: { session_id: 'sess_other' } })).rejects.toMatchObject({ code: 'stale_callback' });
        await expect(managedCheckpoint(binding, { version: 1, state: { session_id: 'sess_one' } })).rejects.toMatchObject({ code: 'stale_callback' });
    });
});
