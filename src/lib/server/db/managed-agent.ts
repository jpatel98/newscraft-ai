import { sql } from 'drizzle-orm';
import { db } from './index';
import { HermesRunRepositoryError } from './hermes-runs';

export interface ManagedBinding {
    accountId: string; runId: string; tenantKey: string; leaseOwner: string; leaseToken: string;
}
export interface ManagedCheckpoint { version: number; state: Record<string, unknown> }

/** A lease-checked compare-and-swap. This table never enters the public event log. */
export async function managedCheckpoint(binding: ManagedBinding, update?: ManagedCheckpoint): Promise<ManagedCheckpoint> {
    if (update && (!Number.isSafeInteger(update.version) || update.version < 0 ||
        !update.state || typeof update.state !== 'object' || Array.isArray(update.state) ||
        Buffer.byteLength(JSON.stringify(update.state)) > 1024 * 1024)) {
        throw new HermesRunRepositoryError('invalid_input', 'invalid managed checkpoint');
    }
    return db.transaction(async (tx: any) => {
        const [run] = await tx.execute(sql`
            SELECT * FROM hermes_runs WHERE id = ${binding.runId} AND account_id = ${binding.accountId}
            FOR UPDATE
        `);
        if (!run || run.tenant_key !== binding.tenantKey) throw new HermesRunRepositoryError('not_found', 'run not found');
        if (run.lease_owner !== binding.leaseOwner || run.lease_token !== binding.leaseToken ||
            !run.lease_expires_at || Number(run.lease_expires_at) <= Date.now()) {
            throw new HermesRunRepositoryError('stale_lease', 'run lease is no longer active');
        }
        const [owner] = await tx.execute(sql`SELECT id FROM conversations
            WHERE id = ${run.conversation_id} AND account_id = ${binding.accountId} FOR UPDATE`);
        if (!owner) throw new HermesRunRepositoryError('not_found', 'conversation not found');
        let [row] = await tx.execute(sql`SELECT * FROM managed_agent_sessions WHERE conversation_id = ${run.conversation_id} FOR UPDATE`);
        if (!row) {
            await tx.execute(sql`INSERT INTO managed_agent_sessions
                (conversation_id, account_id, active_run_id, updated_at)
                VALUES (${run.conversation_id}, ${binding.accountId}, ${binding.runId}, ${Date.now()})`);
            row = { account_id: binding.accountId, active_run_id: binding.runId, state_json: '{}', version: 0, session_id: null };
        }
        if (row.account_id !== binding.accountId) throw new HermesRunRepositoryError('not_found', 'session not found');
        let state = JSON.parse(row.state_json);
        if (row.active_run_id !== binding.runId) {
            if (!['finished', 'failed', 'cancelled'].includes(state.phase)) {
                throw new HermesRunRepositoryError('stale_callback', 'The previous managed turn needs reconciliation before new work can start.');
            }
            if (update) throw new HermesRunRepositoryError('stale_callback', 'managed run binding changed');
            state = row.session_id ? { session_id: row.session_id } : {};
            await tx.execute(sql`UPDATE managed_agent_sessions SET active_run_id = ${binding.runId},
                state_json = ${JSON.stringify(state)}, version = version + 1, updated_at = ${Date.now()}
                WHERE conversation_id = ${run.conversation_id}`);
            return { version: Number(row.version) + 1, state };
        }
        if (!update) return { version: Number(row.version), state };
        if (Number(row.version) !== update.version) {
            // A lost acknowledgement may be retried with the same exact state.
            if (Number(row.version) === update.version + 1 && JSON.stringify(state) === JSON.stringify(update.state)) {
                return { version: Number(row.version), state };
            }
            throw new HermesRunRepositoryError('stale_callback', 'managed checkpoint changed');
        }
        const session = update.state.session_id ?? row.session_id;
        if (session !== null && session !== undefined && (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(session))) {
            throw new HermesRunRepositoryError('invalid_input', 'invalid managed session identity');
        }
        if (row.session_id && row.session_id !== session) throw new HermesRunRepositoryError('stale_callback', 'managed session identity changed');
        await tx.execute(sql`UPDATE managed_agent_sessions SET state_json = ${JSON.stringify(update.state)},
            session_id = ${session ?? null}, version = version + 1, updated_at = ${Date.now()}
            WHERE conversation_id = ${run.conversation_id}`);
        return { version: update.version + 1, state: update.state };
    });
}
