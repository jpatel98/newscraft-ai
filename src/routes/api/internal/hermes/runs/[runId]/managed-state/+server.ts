import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import { managedCheckpoint } from '$lib/server/db/managed-agent';
import { HermesRunRepositoryError } from '$lib/server/db/hermes-runs';

export const POST: RequestHandler = async ({ request, params }) => {
    if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
    let body;
    try {
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 1024 * 1024 + 4096) return json({ detail: 'checkpoint too large' }, { status: 413 });
        body = JSON.parse(raw);
    } catch { return json({ detail: 'invalid json' }, { status: 400 }); }
    const fields = ['account_id', 'tenant_key', 'lease_owner', 'lease_token'] as const;
    if (!params.runId || !body || fields.some(k => typeof body[k] !== 'string' || !body[k].trim())) {
        return json({ detail: 'lease binding required' }, { status: 400 });
    }
    try {
        const result = await managedCheckpoint({ runId: params.runId, accountId: body.account_id,
            tenantKey: body.tenant_key, leaseOwner: body.lease_owner, leaseToken: body.lease_token },
            body.state === undefined ? undefined : { version: body.version, state: body.state });
        return json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (cause) {
        if (cause instanceof HermesRunRepositoryError) return json({ detail: cause.message, code: cause.code },
            { status: cause.code === 'not_found' ? 404 : cause.code === 'invalid_input' ? 400 : 409 });
        throw cause;
    }
};
