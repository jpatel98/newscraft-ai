import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('./index', () => ({ db: database }));
import { runtimeCheckpoint, MAX_RUNTIME_STATE_BYTES } from './agent-runtime';
const binding = { accountId: 'account-one', runId: 'run-one', tenantKey: 'tenant-one', leaseOwner: 'worker-one', leaseToken: 'lease-one' };
function transaction(options: { owner?: boolean; run?: boolean; tenant?: string; lease?: string; expires?: number; version?: number; state?: object; runState?: string; cancelledAt?: number } = {}) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (statement: any) => {
        const query = new PgDialect().sqlToQuery(statement); queries.push(query);
        if (query.sql.includes('SELECT * FROM hermes_runs')) return options.run === false ? [] : [{ state: options.runState ?? 'researching', cancel_requested_at: options.cancelledAt ?? null, tenant_key: options.tenant ?? 'tenant-one', lease_owner: 'worker-one', lease_token: options.lease ?? 'lease-one', lease_expires_at: options.expires ?? Date.now() + 60000, conversation_id: 'conversation-one' }];
        if (query.sql.includes('SELECT id FROM conversations')) return options.owner === false ? [] : [{ id: 'conversation-one' }];
        if (query.sql.includes('SELECT state_json')) return [{ version: options.version ?? 3, state_json: JSON.stringify(options.state ?? { private: 'opaque continuation' }) }];
        return [];
    });
    database.transaction.mockImplementation(operation => operation({ execute }));
    return queries;
}
describe('portable runtime checkpoint', () => {
    beforeEach(() => vi.clearAllMocks());
    it('binds private reads to run, account, conversation, tenant and lease', async () => {
        const queries = transaction();
        expect(await runtimeCheckpoint(binding)).toMatchObject({ version: 3 });
        expect(queries[0].params).toEqual(['run-one', 'account-one']);
        expect(queries[1].params).toEqual(['conversation-one', 'account-one']);
        expect(queries[2].params).toEqual(['run-one', 'account-one']);
    });
    it.each([{ owner: false }, { run: false }, { tenant: 'another-tenant' }])('rejects cross-user bindings without a write: %j', async options => {
        const queries = transaction(options);
        await expect(runtimeCheckpoint(binding, { version: 3, state: {} })).rejects.toMatchObject({ code: 'not_found' });
        expect(queries.every(q => q.sql.trim().startsWith('SELECT'))).toBe(true);
    });
    it.each([{ lease: 'stale' }, { expires: 1 }])('rejects inactive leases: %j', async options => {
        const queries = transaction(options);
        await expect(runtimeCheckpoint(binding)).rejects.toMatchObject({ code: 'stale_lease' });
        expect(queries).toHaveLength(1);
    });
    it('accepts an exact lost-ack CAS replay without writing twice', async () => {
        const queries = transaction({ state: { intent: 'model' } });
        expect(await runtimeCheckpoint(binding, { version: 2, state: { intent: 'model' } })).toEqual({ version: 3, state: { intent: 'model' } });
        expect(queries).toHaveLength(3);
        await expect(runtimeCheckpoint(binding, { version: 2, state: { intent: 'different' } })).rejects.toMatchObject({ code: 'stale_callback' });
    });
    it('persists the next version under the same run scope', async () => {
        const queries = transaction();
        expect(await runtimeCheckpoint(binding, { version: 3, state: { intent: 'tool', private: 'not public' } })).toMatchObject({ version: 4 });
        expect(queries[3].params.slice(0, 2)).toEqual(['run-one', 'account-one']);
    });
    it.each([{ runState: 'cancel_requested' }, { cancelledAt: 1 }])('denies dispatch after committed cancellation, including a renewed lease: %j', async options => {
        const queries = transaction({ ...options, expires: Date.now() + 90000 });
        await expect(runtimeCheckpoint(binding, { version: 3, state: { intent: 'model' } }, true)).rejects.toMatchObject({ code: 'cancel_requested' });
        expect(queries).toHaveLength(2);
        expect(queries.every(q => q.sql.trim().startsWith('SELECT'))).toBe(true);
        // Same owned lease can still reconcile/cancel state; no new action admission.
        expect(await runtimeCheckpoint(binding)).toMatchObject({ version: 3 });
        expect(await runtimeCheckpoint(binding, { version: 3, state: { phase: 'cancelled' } })).toMatchObject({ version: 4 });
    });
    it.each(['complete', 'failed', 'cancelled'])('denies dispatch for terminal run state %s', async runState => {
        const queries = transaction({ runState });
        await expect(runtimeCheckpoint(binding, { version: 3, state: { intent: 'model' } }, true)).rejects.toMatchObject({ code: 'terminal' });
        expect(queries).toHaveLength(2);
    });
    it('rejects oversized state before querying the database', async () => {
        await expect(runtimeCheckpoint(binding, { version: 0, state: { text: 'x'.repeat(MAX_RUNTIME_STATE_BYTES) } })).rejects.toMatchObject({ code: 'invalid_input' });
        expect(database.transaction).not.toHaveBeenCalled();
    });
});
