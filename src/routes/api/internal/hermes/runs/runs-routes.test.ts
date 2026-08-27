import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	getHermesRun: vi.fn(),
	appendHermesRunEvent: vi.fn(),
	claimHermesRunLease: vi.fn(),
	renewHermesRunLease: vi.fn(),
	reclaimQueuedOrExpiredHermesRuns: vi.fn(),
	requestHermesRunCancellation: vi.fn(),
	finalizeHermesRunCancellation: vi.fn(),
	listHermesRunEvents: vi.fn(),
	snapshotFromRun: vi.fn((run) => ({ state: run.state, answerText: run.answerText || '', sources: [], citations: [], tools: [], errorMessage: null }))
}));
const authMocks = vi.hoisted(() => ({ verifyHermesRunCallback: vi.fn(), cancelDurableHermesRun: vi.fn() }));
const titleMocks = vi.hoisted(() => ({ generateConversationTitle: vi.fn(), withChatTimeout: vi.fn((value) => value) }));
const diagnosticMocks = vi.hoisted(() => ({ recordChatDiagnostic: vi.fn() }));

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
vi.mock('$lib/server/conversation-title', () => ({ generateConversationTitle: titleMocks.generateConversationTitle }));
vi.mock('$lib/server/chat-timeouts', () => ({ CHAT_TITLE_TIMEOUT_MS: 5000, withChatTimeout: titleMocks.withChatTimeout }));
vi.mock('$lib/server/chat-diagnostics', () => diagnosticMocks);

import { POST as callback } from './callback/+server';
import { POST as claim } from './claim/+server';
import { POST as renew } from './renew/+server';
import { GET as subscribe } from '../../../chat/runs/[id]/+server';
import { POST as cancel } from '../../../chat/runs/[id]/cancel/+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };
const run = {
	id: 'run-1', accountId: user.id, tenantKey: 'tenant_key_1', conversationId: 'conversation-1', state: 'researching', cursor: 1,
	workerCursor: 1, answerText: 'Hello', leaseOwner: 'worker-1', leaseToken: 'lease-1', leaseExpiresAt: Date.now() + 60_000,
	inputJson: JSON.stringify({ trace_id: 'trace_12345678', forwardedProps: { retrievalBackend: 'newscraft-local', archiveFallback: 'wayback' } }),
	createdAt: 1_000, startedAt: 1_100, completedAt: null, cancelRequestedAt: null
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
			trace_id: 'trace_12345678',
			...overrides
		})
	});
}

function claimRequest(overrides: Record<string, unknown> = {}) {
	return new Request('http://localhost/api/internal/hermes/runs/claim', {
		method: 'POST',
		headers: { 'x-newscraft-hermes-token': 'run-token' },
		body: JSON.stringify({
			run_id: run.id,
			account_id: user.id,
			tenant_key: 'tenant_key_1',
			lease_owner: 'worker-1',
			trace_id: 'trace_12345678',
			...overrides
		})
	});
}

function renewRequest(overrides: Record<string, unknown> = {}) {
	return new Request('http://localhost/api/internal/hermes/runs/renew', {
		method: 'POST',
		headers: { 'x-newscraft-hermes-token': 'run-token' },
		body: JSON.stringify({
			run_id: run.id,
			account_id: user.id,
			tenant_key: 'tenant_key_1',
			lease_owner: 'worker-1',
			lease_token: 'lease-1',
			trace_id: 'trace_12345678',
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
		dbMocks.listHermesRunEvents.mockResolvedValue([]);
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

	it('rejects a callback trace that does not match the persisted run trace', async () => {
		const response = await callback({ request: callbackRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.appendHermesRunEvent).not.toHaveBeenCalled();
	});

	it('rejects a callback with no trace before state mutation', async () => {
		const response = await callback({ request: callbackRequest({ trace_id: undefined }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.appendHermesRunEvent).not.toHaveBeenCalled();
	});

	it('rejects a callback with a malformed trace before state mutation', async () => {
		const response = await callback({ request: callbackRequest({ trace_id: 123 }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
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

	it('generates one best-effort title after a durable answer completes', async () => {
		dbMocks.appendHermesRunEvent.mockResolvedValue({
			run: { ...run, state: 'complete', assistantMessageId: 'assistant-1' },
			event: { cursor: 2 }
		});
		dbMocks.listHermesRunEvents.mockResolvedValue([
			{ cursor: 1, eventType: 'run.started', dataJson: '{}', createdAt: 1_100 },
			{ cursor: 2, eventType: 'response.completed', dataJson: '{}', createdAt: 1_500 }
		]);
		const response = await callback({
			request: callbackRequest({ event_type: 'response.completed' })
		} as any);

		expect(response.status).toBe(200);
		expect(titleMocks.generateConversationTitle).toHaveBeenCalledWith(user.id, run.conversationId, {
			idempotencyKey: 'title-conversation-1-assistant-1'
		});
		expect(diagnosticMocks.recordChatDiagnostic).toHaveBeenCalledWith(
			run.conversationId,
			'chat.durable.terminal',
			expect.objectContaining({ trace_id: 'trace_12345678', terminal_state: 'complete' }),
			{ id: 'durable-terminal:run-1' }
		);
	});
});

describe('Hermes internal trace-bound control routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyHermesRunCallback.mockReturnValue(true);
		dbMocks.getHermesRun.mockResolvedValue(run);
		dbMocks.claimHermesRunLease.mockResolvedValue({ ...run, leaseToken: 'lease-2' });
		dbMocks.renewHermesRunLease.mockResolvedValue(run);
	});

	it('rejects a claim with no persisted trace binding supplied', async () => {
		const response = await claim({ request: claimRequest({ trace_id: undefined }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.claimHermesRunLease).not.toHaveBeenCalled();
	});

	it('rejects a claim with a mismatched trace before state mutation', async () => {
		const response = await claim({ request: claimRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.claimHermesRunLease).not.toHaveBeenCalled();
	});

	it('rejects a claim with a malformed trace before state mutation', async () => {
		const response = await claim({ request: claimRequest({ trace_id: 123 }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.claimHermesRunLease).not.toHaveBeenCalled();
	});

	it('labels a genuine claim lease conflict without exposing trace data', async () => {
		dbMocks.getHermesRun.mockResolvedValue({ ...run, leaseOwner: 'worker-2', leaseToken: 'lease-other' });
		dbMocks.claimHermesRunLease.mockResolvedValue(null);
		const response = await claim({ request: claimRequest() } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'lease_conflict', detail: 'run lease is held by another worker' });
		expect(JSON.stringify(body)).not.toContain('trace_12345678');
	});

	it('rejects a renew with no persisted trace binding supplied', async () => {
		const response = await renew({ request: renewRequest({ trace_id: undefined }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.renewHermesRunLease).not.toHaveBeenCalled();
	});

	it('rejects a renew with a mismatched trace before state mutation', async () => {
		const response = await renew({ request: renewRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.renewHermesRunLease).not.toHaveBeenCalled();
	});

	it('rejects a renew with a malformed trace before state mutation', async () => {
		const response = await renew({ request: renewRequest({ trace_id: 123 }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.renewHermesRunLease).not.toHaveBeenCalled();
	});

	it('keeps no-trace control requests working only for legacy saved runs', async () => {
		dbMocks.getHermesRun.mockResolvedValue({ ...run, inputJson: JSON.stringify({ forwardedProps: {} }) });
		dbMocks.claimHermesRunLease.mockResolvedValue({ ...run, inputJson: JSON.stringify({ forwardedProps: {} }) });
		dbMocks.renewHermesRunLease.mockResolvedValue({ ...run, inputJson: JSON.stringify({ forwardedProps: {} }) });
		dbMocks.appendHermesRunEvent.mockResolvedValue({
			run: { ...run, inputJson: JSON.stringify({ forwardedProps: {} }) },
			event: { cursor: 2 }
		});

		expect((await claim({ request: claimRequest({ trace_id: undefined }) } as any)).status).toBe(200);
		expect((await renew({ request: renewRequest({ trace_id: undefined }) } as any)).status).toBe(200);
		expect((await callback({ request: callbackRequest({ trace_id: undefined }) } as any)).status).toBe(200);
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
		authMocks.cancelDurableHermesRun.mockResolvedValue({ state: 'cancel_requested' });
		dbMocks.finalizeHermesRunCancellation.mockResolvedValue({ ...run, state: 'cancelled', cursor: 3 });
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
		expect(body).toContain('"trace_id":"trace_12345678"');
		expect(diagnosticMocks.recordChatDiagnostic).toHaveBeenCalledWith(
			run.conversationId,
			'chat.durable.subscription',
			expect.objectContaining({ trace_id: 'trace_12345678', replay: true, reconnect_count: 1, after_cursor: 1 })
		);
	});

	it('cancels the same account-scoped run and asks Hermes to stop it', async () => {
		const response = await cancel({ locals: { user }, params: { id: 'run-1' } } as any);
		expect(response.status).toBe(202);
		expect(dbMocks.requestHermesRunCancellation).toHaveBeenCalledWith(user.id, run.id);
		expect(authMocks.cancelDurableHermesRun).toHaveBeenCalledWith(user.id, run.id, 'trace_12345678');
	});

	it('finalizes a saved cancellation when Hermes confirms no worker is running', async () => {
		authMocks.cancelDurableHermesRun.mockResolvedValue({ state: 'not_running' });
		const response = await cancel({ locals: { user }, params: { id: 'run-1' } } as any);

		expect(response.status).toBe(202);
		expect(dbMocks.finalizeHermesRunCancellation).toHaveBeenCalledWith(user.id, run.id);
		expect(await response.json()).toMatchObject({ state: 'cancelled' });
	});
});
