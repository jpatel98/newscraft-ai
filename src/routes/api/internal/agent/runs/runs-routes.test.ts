import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	getAgentRun: vi.fn(),
	getAgentRunSubscriptionState: vi.fn(),
	reconcileExpiredAgentRun: vi.fn(),
	appendAgentRunEvents: vi.fn(),
	claimAgentRunLease: vi.fn(),
	renewAgentRunLease: vi.fn(),
	reclaimQueuedOrExpiredAgentRuns: vi.fn(),
	failQueuedAgentRun: vi.fn(),
	releaseAgentRunLease: vi.fn(),
	requestAgentRunCancellation: vi.fn(),
	finalizeAgentRunCancellation: vi.fn(),
	listAgentRunEvents: vi.fn(),
	listKnownAgentRunEvents: vi.fn(),
	snapshotFromRun: vi.fn((run) => ({ state: run.state, answerText: run.answerText || '', sources: [], citations: [], tools: [], errorMessage: null }))
}));
const authMocks = vi.hoisted(() => ({ verifyAgentRunCallback: vi.fn(), cancelDurableAgentRun: vi.fn() }));
const titleMocks = vi.hoisted(() => ({ generateConversationTitle: vi.fn(), withChatTimeout: vi.fn((value) => value) }));
const diagnosticMocks = vi.hoisted(() => ({ recordChatDiagnostic: vi.fn() }));

vi.mock('$lib/server/db/agent-runs', () => ({
	...dbMocks,
	AGENT_TERMINAL_STATES: ['cancelled', 'failed', 'complete'],
	AGENT_RECOVERY_GRACE_MS: 45_000,
	AgentRunRepositoryError: class AgentRunRepositoryError extends Error {
		code: string;
		constructor(code: string, message: string) {
			super(message);
			this.code = code;
		}
	}
}));
vi.mock('$lib/server/agent-durable', () => authMocks);
vi.mock('$lib/server/conversation-title', () => ({ generateConversationTitle: titleMocks.generateConversationTitle }));
vi.mock('$lib/server/chat-timeouts', () => ({ CHAT_TITLE_TIMEOUT_MS: 5000, withChatTimeout: titleMocks.withChatTimeout }));
vi.mock('$lib/server/chat-diagnostics', () => diagnosticMocks);

import { POST as callback } from './callback/+server';
import { POST as claim } from './claim/+server';
import { POST as fail } from './fail/+server';
import { POST as release } from './release/+server';
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
	return new Request('http://localhost/api/internal/agent/runs/callback', {
		method: 'POST',
		headers: { 'x-newscraft-agent-token': 'run-token' },
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
	return new Request('http://localhost/api/internal/agent/runs/claim', {
		method: 'POST',
		headers: { 'x-newscraft-agent-token': 'run-token' },
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
	return new Request('http://localhost/api/internal/agent/runs/renew', {
		method: 'POST',
		headers: { 'x-newscraft-agent-token': 'run-token' },
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

function failRequest(overrides: Record<string, unknown> = {}) {
	return new Request('http://localhost/api/internal/agent/runs/fail', {
		method: 'POST',
		headers: { 'x-newscraft-agent-token': 'run-token' },
		body: JSON.stringify({
			run_id: run.id,
			account_id: user.id,
			tenant_key: 'tenant_key_1',
			reason: 'overload',
			trace_id: 'trace_12345678',
			...overrides
		})
	});
}

function releaseRequest(overrides: Record<string, unknown> = {}) {
	return new Request('http://localhost/api/internal/agent/runs/release', {
		method: 'POST',
		headers: { 'x-newscraft-agent-token': 'run-token' },
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

describe('Agent internal run routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyAgentRunCallback.mockReturnValue(true);
		dbMocks.getAgentRun.mockResolvedValue(run);
		dbMocks.appendAgentRunEvents.mockResolvedValue({ run, event: { cursor: 2 } });
		dbMocks.listAgentRunEvents.mockResolvedValue([]);
	});

	it('rejects callbacks with the wrong server token before reading run state', async () => {
		authMocks.verifyAgentRunCallback.mockReturnValue(false);
		const response = await callback({ request: callbackRequest() } as any);
		expect(response.status).toBe(401);
		expect(dbMocks.getAgentRun).not.toHaveBeenCalled();
	});

	it('rejects a callback for the wrong account', async () => {
		dbMocks.getAgentRun.mockResolvedValue(null);
		const response = await callback({ request: callbackRequest({ account_id: 'account-2' }) } as any);
		expect(response.status).toBe(404);
		expect(dbMocks.appendAgentRunEvents).not.toHaveBeenCalled();
	});

	it('rejects a callback for the wrong tenant', async () => {
		const response = await callback({ request: callbackRequest({ tenant_key: 'tenant_key_2' }) } as any);
		expect(response.status).toBe(404);
		expect(dbMocks.appendAgentRunEvents).not.toHaveBeenCalled();
	});

	it('rejects a callback trace that does not match the persisted run trace', async () => {
		const response = await callback({ request: callbackRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.appendAgentRunEvents).not.toHaveBeenCalled();
	});

	it('rejects a callback with no trace before state mutation', async () => {
		const response = await callback({ request: callbackRequest({ trace_id: undefined }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.appendAgentRunEvents).not.toHaveBeenCalled();
	});

	it('rejects a callback with a malformed trace before state mutation', async () => {
		const response = await callback({ request: callbackRequest({ trace_id: 123 }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.appendAgentRunEvents).not.toHaveBeenCalled();
	});

	it.each([
		['stale_lease', 'stale lease'],
		['stale_callback', 'stale cursor']
	])('rejects %s from the repository', async (code, message) => {
		const error = new (await import('$lib/server/db/agent-runs')).AgentRunRepositoryError(code as any, message);
		dbMocks.appendAgentRunEvents.mockRejectedValue(error);
		const response = await callback({ request: callbackRequest() } as any);
		const body = await response.json();
		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code, detail: message });
	});

	it('appends an authenticated callback through the tenant-scoped repository', async () => {
		const response = await callback({ request: callbackRequest() } as any);
		expect(response.status).toBe(200);
		expect(dbMocks.appendAgentRunEvents).toHaveBeenCalledWith(
			user.id,
			run.id,
			'worker-1',
			'lease-1',
			[expect.objectContaining({ workerCursor: 2, eventType: 'response.output_text.delta' })]
		);
	});

	it('accepts ordered event batches and rejects ambiguous or malformed batches', async () => {
		const events = [
			{ worker_cursor: 2, event_type: 'response.output_text.delta', data: { delta: 'one' } },
			{ worker_cursor: 3, event_type: 'response.completed', data: {} }
		];
		const response = await callback({ request: callbackRequest({ worker_cursor: undefined, event_type: undefined, events }) } as any);
		expect(response.status).toBe(200);
		expect(dbMocks.appendAgentRunEvents).toHaveBeenLastCalledWith(user.id, run.id, 'worker-1', 'lease-1', [
			expect.objectContaining({ workerCursor: 2, eventType: events[0].event_type }),
			expect.objectContaining({ workerCursor: 3, eventType: events[1].event_type })
		]);
		for (const invalid of [[], [null], new Array(33).fill(events[0]), [{ event_type: 5 }]]) {
			expect((await callback({ request: callbackRequest({ worker_cursor: undefined, event_type: undefined, events: invalid }) } as any)).status).toBe(400);
		}
		expect((await callback({ request: callbackRequest({ events }) } as any)).status).toBe(400);
	});

	it('generates one best-effort title after a durable answer completes', async () => {
		dbMocks.appendAgentRunEvents.mockResolvedValue({
			run: { ...run, state: 'complete', assistantMessageId: 'assistant-1' },
			event: { cursor: 2 }
		});
		dbMocks.listAgentRunEvents.mockResolvedValue([
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

describe('Agent internal trace-bound control routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyAgentRunCallback.mockReturnValue(true);
		dbMocks.getAgentRun.mockResolvedValue(run);
		dbMocks.claimAgentRunLease.mockResolvedValue({ ...run, leaseToken: 'lease-2' });
		dbMocks.renewAgentRunLease.mockResolvedValue(run);
		dbMocks.failQueuedAgentRun.mockResolvedValue({ ...run, state: 'failed' });
		dbMocks.releaseAgentRunLease.mockResolvedValue({ ...run, leaseOwner: null, leaseToken: null });
	});

	it('rejects a claim with no persisted trace binding supplied', async () => {
		const response = await claim({ request: claimRequest({ trace_id: undefined }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.claimAgentRunLease).not.toHaveBeenCalled();
	});

	it('rejects a claim with a mismatched trace before state mutation', async () => {
		const response = await claim({ request: claimRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.claimAgentRunLease).not.toHaveBeenCalled();
	});

	it('rejects a claim with a malformed trace before state mutation', async () => {
		const response = await claim({ request: claimRequest({ trace_id: 123 }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.claimAgentRunLease).not.toHaveBeenCalled();
	});

	it('labels a genuine claim lease conflict without exposing trace data', async () => {
		dbMocks.getAgentRun.mockResolvedValue({ ...run, leaseOwner: 'worker-2', leaseToken: 'lease-other' });
		dbMocks.claimAgentRunLease.mockResolvedValue(null);
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
		expect(dbMocks.renewAgentRunLease).not.toHaveBeenCalled();
	});

	it('rejects a renew with a mismatched trace before state mutation', async () => {
		const response = await renew({ request: renewRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.renewAgentRunLease).not.toHaveBeenCalled();
	});

	it('rejects a renew with a malformed trace before state mutation', async () => {
		const response = await renew({ request: renewRequest({ trace_id: 123 }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.renewAgentRunLease).not.toHaveBeenCalled();
	});

	it('keeps no-trace control requests working only for legacy saved runs', async () => {
		dbMocks.getAgentRun.mockResolvedValue({ ...run, inputJson: JSON.stringify({ forwardedProps: {} }) });
		dbMocks.claimAgentRunLease.mockResolvedValue({ ...run, inputJson: JSON.stringify({ forwardedProps: {} }) });
		dbMocks.renewAgentRunLease.mockResolvedValue({ ...run, inputJson: JSON.stringify({ forwardedProps: {} }) });
		dbMocks.appendAgentRunEvents.mockResolvedValue({
			run: { ...run, inputJson: JSON.stringify({ forwardedProps: {} }) },
			event: { cursor: 2 }
		});

		expect((await claim({ request: claimRequest({ trace_id: undefined }) } as any)).status).toBe(200);
		expect((await renew({ request: renewRequest({ trace_id: undefined }) } as any)).status).toBe(200);
		expect((await callback({ request: callbackRequest({ trace_id: undefined }) } as any)).status).toBe(200);
	});
});

describe('Agent overload and recovery lease routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyAgentRunCallback.mockReturnValue(true);
		dbMocks.getAgentRun.mockResolvedValue(run);
		dbMocks.failQueuedAgentRun.mockResolvedValue({ ...run, state: 'failed' });
		dbMocks.releaseAgentRunLease.mockResolvedValue({ ...run, state: 'queued', leaseOwner: null, leaseToken: null });
	});

	it('persists overload through the existing queued-run failure repository path', async () => {
		const response = await fail({ request: failRequest() } as any);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({ state: 'failed' });
		expect(dbMocks.failQueuedAgentRun).toHaveBeenCalledWith(
			user.id,
			run.id,
			'Research service is temporarily at capacity. Try again shortly.',
			'overload'
		);
		expect(JSON.stringify(body)).not.toContain('tenant_key_1');
	});

	it('rejects an admission failure trace mismatch before repository mutation', async () => {
		const response = await fail({ request: failRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.failQueuedAgentRun).not.toHaveBeenCalled();
	});

	it('returns a recovered lease through the existing repository lease path', async () => {
		const response = await release({ request: releaseRequest() } as any);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ state: 'queued' });
		expect(dbMocks.releaseAgentRunLease).toHaveBeenCalledWith(
			user.id,
			run.id,
			'worker-1',
			'lease-1'
		);
	});

	it('rejects a recovery lease trace mismatch before repository mutation', async () => {
		const response = await release({ request: releaseRequest({ trace_id: 'trace_87654321' }) } as any);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ code: 'trace_binding' });
		expect(dbMocks.releaseAgentRunLease).not.toHaveBeenCalled();
	});
});

describe('Agent browser run routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifyAgentRunCallback.mockReturnValue(true);
		dbMocks.getAgentRun.mockResolvedValue({ ...run, state: 'complete', cursor: 2, workerCursor: 2 });
		dbMocks.listKnownAgentRunEvents.mockResolvedValue([
			{ cursor: 2, eventType: 'response.completed', dataJson: '{"ok":true}' }
		]);
		dbMocks.requestAgentRunCancellation.mockResolvedValue({ ...run, state: 'cancel_requested', cursor: 2 });
		authMocks.cancelDurableAgentRun.mockResolvedValue({ state: 'cancel_requested' });
		dbMocks.finalizeAgentRunCancellation.mockResolvedValue({ ...run, state: 'cancelled', cursor: 3 });
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
		expect(dbMocks.getAgentRun).toHaveBeenCalledTimes(1);
		expect(dbMocks.getAgentRunSubscriptionState).not.toHaveBeenCalled();
		expect(dbMocks.reconcileExpiredAgentRun).not.toHaveBeenCalled();
		expect(dbMocks.listKnownAgentRunEvents).toHaveBeenCalledWith(user.id, run.id, 1, 500);
		expect(body).toContain('event: run.snapshot');
		expect(body).toContain('id: 2');
		expect(body).toContain('event: response.completed');
		expect(body).toContain('"trace_id":"trace_12345678"');
		expect(diagnosticMocks.recordChatDiagnostic).toHaveBeenCalledWith(
			run.conversationId,
			'chat.durable.subscription',
			expect.objectContaining({ trace_id: 'trace_12345678', replay: true, reconnect_count: 1, after_cursor: 1 })
		);
	});

	it('cancels the same account-scoped run and asks agent to stop it', async () => {
		const response = await cancel({ locals: { user }, params: { id: 'run-1' } } as any);
		expect(response.status).toBe(202);
		expect(dbMocks.requestAgentRunCancellation).toHaveBeenCalledWith(user.id, run.id);
		expect(authMocks.cancelDurableAgentRun).toHaveBeenCalledWith(user.id, run.id, 'trace_12345678');
	});

	it('finalizes a saved cancellation when agent confirms no worker is running', async () => {
		authMocks.cancelDurableAgentRun.mockResolvedValue({ state: 'not_running' });
		const response = await cancel({ locals: { user }, params: { id: 'run-1' } } as any);

		expect(response.status).toBe(202);
		expect(dbMocks.finalizeAgentRunCancellation).toHaveBeenCalledWith(user.id, run.id);
		expect(await response.json()).toMatchObject({ state: 'cancelled' });
	});
});
