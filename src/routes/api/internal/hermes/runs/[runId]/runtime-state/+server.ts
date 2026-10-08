import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import { runtimeCheckpoint, MAX_RUNTIME_STATE_BYTES } from '$lib/server/db/agent-runtime';
import { HermesRunRepositoryError } from '$lib/server/db/hermes-runs';

export const POST: RequestHandler = async ({ request, params }) => {
    if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
    let body;
    const reader = request.body?.getReader();
    if (!reader) return json({ detail: 'body required' }, { status: 400 });
    try {
        const chunks = []; let size = 0;
        while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_RUNTIME_STATE_BYTES + 4096) { await reader.cancel(); return json({ detail: 'checkpoint too large' }, { status: 413 }); }
            chunks.push(Buffer.from(chunk.value));
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return json({ detail: 'invalid json' }, { status: 400 }); }
    finally { reader.releaseLock(); }
    const fields = ['account_id', 'tenant_key', 'lease_owner', 'lease_token'] as const;
    if (!params.runId || !body || fields.some(k => typeof body[k] !== 'string' || !body[k].trim()) ||
        (body.dispatch !== undefined && typeof body.dispatch !== 'boolean')) return json({ detail: 'lease binding required' }, { status: 400 });
    try {
        const result = await runtimeCheckpoint({ runId: params.runId, accountId: body.account_id,
            tenantKey: body.tenant_key, leaseOwner: body.lease_owner, leaseToken: body.lease_token },
            body.state === undefined ? undefined : { version: body.version, state: body.state }, body.dispatch === true);
        return json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (cause) {
        if (cause instanceof HermesRunRepositoryError) return json({ detail: cause.message, code: cause.code },
            { status: cause.code === 'not_found' ? 404 : cause.code === 'invalid_input' ? 400 : 409 });
        throw cause;
    }
};
