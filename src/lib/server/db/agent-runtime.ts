import { sql } from 'drizzle-orm';
import { db } from './index';
import { HermesRunRepositoryError, HERMES_TERMINAL_STATES } from './hermes-runs';

export interface RuntimeBinding { accountId: string; runId: string; tenantKey: string; leaseOwner: string; leaseToken: string }
export interface RuntimeCheckpoint { version: number; state: Record<string, unknown> }
export const MAX_RUNTIME_STATE_BYTES = 8 * 1024 * 1024;

/** Run-scoped, provider-neutral state. Never exposed through public replay. */
export async function runtimeCheckpoint(binding: RuntimeBinding, update?: RuntimeCheckpoint, dispatch = false): Promise<RuntimeCheckpoint> {
    if (update && (!Number.isSafeInteger(update.version) || update.version < 0 || !update.state ||
        typeof update.state !== 'object' || Array.isArray(update.state) || Buffer.byteLength(JSON.stringify(update.state)) > MAX_RUNTIME_STATE_BYTES)) {
        throw new HermesRunRepositoryError('invalid_input', 'invalid runtime checkpoint');
    }
    return db.transaction(async (tx: any) => {
        const [run] = await tx.execute(sql`SELECT * FROM hermes_runs WHERE id = ${binding.runId} AND account_id = ${binding.accountId} FOR UPDATE`);
        if (!run || run.tenant_key !== binding.tenantKey) throw new HermesRunRepositoryError('not_found', 'run not found');
        if (run.lease_owner !== binding.leaseOwner || run.lease_token !== binding.leaseToken ||
            !run.lease_expires_at || Number(run.lease_expires_at) <= Date.now()) throw new HermesRunRepositoryError('stale_lease', 'run lease is no longer active');
        const [owner] = await tx.execute(sql`SELECT id FROM conversations WHERE id = ${run.conversation_id} AND account_id = ${binding.accountId}`);
        if (!owner) throw new HermesRunRepositoryError('not_found', 'conversation not found');
        // Cancellation and this admission check serialize on the same run row.
        // Cleanup/checkpoint reads remain available to the current lease owner.
        if (dispatch && (run.state === 'cancel_requested' || run.cancel_requested_at != null)) {
            throw new HermesRunRepositoryError('cancel_requested', 'run cancellation was requested');
        }
        if (dispatch && HERMES_TERMINAL_STATES.includes(run.state)) {
            throw new HermesRunRepositoryError('terminal', 'run has ended');
        }
        const [row] = await tx.execute(sql`SELECT state_json, version FROM agent_runtime_checkpoints
            WHERE run_id = ${binding.runId} AND account_id = ${binding.accountId} FOR UPDATE`);
        const current = { version: Number(row?.version ?? 0), state: row ? JSON.parse(row.state_json) : {} };
        if (!update) return current;
        if (update.version !== current.version) {
            if (current.version === update.version + 1 && JSON.stringify(current.state) === JSON.stringify(update.state)) return current;
            throw new HermesRunRepositoryError('stale_callback', 'runtime checkpoint changed');
        }
        await tx.execute(sql`INSERT INTO agent_runtime_checkpoints (run_id, account_id, state_json, version, updated_at)
            VALUES (${binding.runId}, ${binding.accountId}, ${JSON.stringify(update.state)}, ${update.version + 1}, ${Date.now()})
            ON CONFLICT (run_id) DO UPDATE SET state_json = EXCLUDED.state_json, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`);
        return { version: update.version + 1, state: update.state };
    });
}
