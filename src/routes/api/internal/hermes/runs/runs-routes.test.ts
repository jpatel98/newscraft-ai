import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	getHermesRun: vi.fn(),
	appendHermesRunEvent: vi.fn(),
	claimHermesRunLease: vi.fn(),
	renewHermesRunLease: vi.fn(),
	reclaimQueuedOrExpiredHermesRuns: vi.fn(),
	requestHermesRunCancellation: vi.fn(),
	listHermesRunEvents: vi.fn(),
	snapshotFromRun: vi.fn((run) => ({ state: run.state, answerText: run.answerText || '', sources: [], citations: [], tools: [], errorMessage: null }))
}));
const authMocks = vi.hoisted(() => ({ verifyHermesRunCallback: vi.fn(), cancelDurableHermesRun: vi.fn() }));

vi.mock('$lib/server/db/hermes-runs', () => ({
	...dbMocks,
	HERMES_TERMINAL_STATES: ['cancelled', 'failed', 'complete'],
	HermesRunRepositoryError: class HermesRunRepositoryError extends Error {
		code: string;
		constructor(code: string, message: string) {
			super(message);
			this.code = code;
		}
	}
}));
vi.mock('$lib/server/hermes-durable', () => authMocks);

import { POST as callback } from './callback/+server';
import { GET as subscribe } from '../../../chat/runs/[id]/+server';
import { POST as cancel } from '../../../chat/runs/[id]/cancel/+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };
const run = {
	id: 'run-1', accountId: user.id, tenantKey: 'tenant_key_1', conversationId: 'conversation-1', state: 'researching', cursor: 1,
	workerCursor: 1, answerText: 'Hello', leaseOwner: 'worker-1', leaseToken: 'lease-1', leaseExpiresAt: Date.now() + 60_000
};

function callbackRequest(overrides: Record<string, unknown> = {}) {
	return new Request('http://localhost/api/internal/hermes/runs/callback', {
		method: 'POST',
		headers: { 'x-newscraft-hermes-token': 'run-token' },
		body: JSON.stringify({
			run_id: run.id,
			account_id: user.id,
			tenant_key: 'tenant_key_1',
			lease_owner: 'worker-1',
			lease_token: 'lease-1',
			worker_cursor: 2,
			event_type: 'response.output_text.delta',
			data: { delta: '!' },
			...overrides
		})
	});
}

describe('Hermes internal run routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyHermesRunCallback.mockReturnValue(true);
		dbMocks.getHermesRun.mockResolvedValue(run);
		dbMocks.appendHermesRunEvent.mockResolvedValue({ run, event: { cursor: 2 } });
	});

	it('rejects callbacks with the wrong server token before reading run state', async () => {
		authMocks.verifyHermesRunCallback.mockReturnValue(false);
		const response = await callback({ request: callbackRequest() } as any);
		expect(response.status).toBe(401);
		expect(dbMocks.getHermesRun).not.toHaveBeenCalled();
	});

	it('rejects a callback for the wrong account', async () => {
		dbMocks.getHermesRun.mockResolvedValue(null);
		const response = await callback({ request: callbackRequest({ account_id: 'account-2' }) } as any);
		expect(response.status).toBe(404);
		expect(dbMocks.appendHermesRunEvent).not.toHaveBeenCalled();
	});

	it('rejects a callback for the wrong tenant', async () => {
		const response = await callback({ request: callbackRequest({ tenant_key: 'tenant_key_2' }) } as any);
		expect(response.status).toBe(404);
		expect(dbMocks.appendHermesRunEvent).not.toHaveBeenCalled();
	});

	it.each([
		['stale_lease', 'stale lease'],
		['stale_callback', 'stale cursor']
	])('rejects %s from the repository', async (code, message) => {
		const error = new (await import('$lib/server/db/hermes-runs')).HermesRunRepositoryError(code as any, message);
		dbMocks.appendHermesRunEvent.mockRejectedValue(error);
		const response = await callback({ request: callbackRequest() } as any);
		const body = await response.json();
		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code, detail: message });
	});

	it('appends an authenticated callback through the tenant-scoped repository', async () => {
		const response = await callback({ request: callbackRequest() } as any);
		expect(response.status).toBe(200);
		expect(dbMocks.appendHermesRunEvent).toHaveBeenCalledWith(
		user.id,
		run.id,
		'worker-1',
		'lease-1',
		expect.objectContaining({ workerCursor: 2, eventType: 'response.output_text.delta' })
	);
	});
});

describe('Hermes browser run routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyHermesRunCallback.mockReturnValue(true);
		dbMocks.getHermesRun.mockResolvedValue({ ...run, state: 'complete', cursor: 2, workerCursor: 2 });
		dbMocks.listHermesRunEvents.mockResolvedValue([
			{ cursor: 2, eventType: 'response.completed', dataJson: '{"ok":true}' }
		]);
		dbMocks.requestHermesRunCancellation.mockResolvedValue({ ...run, state: 'cancel_requested', cursor: 2 });
		authMocks.cancelDurableHermesRun.mockResolvedValue(undefined);
	});

	it('replays only events after Last-Event-ID', async () => {
		const response = await subscribe({
			request: new Request('http://localhost/api/chat/runs/run-1', { headers: { 'last-event-id': '1' } }),
			locals: { user },
			params: { id: 'run-1' },
			url: new URL('http://localhost/api/chat/runs/run-1')
		} as any);
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(dbMocks.listHermesRunEvents).toHaveBeenCalledWith(user.id, run.id, 1, 500);
		expect(body).toContain('id: 2');
		expect(body).toContain('event: response.completed');
	});

	it('cancels the same account-scoped run and asks Hermes to stop it', async () => {
		const response = await cancel({ locals: { user }, params: { id: 'run-1' } } as any);
		expect(response.status).toBe(202);
		expect(dbMocks.requestHermesRunCancellation).toHaveBeenCalledWith(user.id, run.id);
		expect(authMocks.cancelDurableHermesRun).toHaveBeenCalledWith(user.id, run.id);
	});
});
