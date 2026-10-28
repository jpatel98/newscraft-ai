import { afterEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	getAgentRun: vi.fn(),
	getAgentRunSubscriptionState: vi.fn(),
	listKnownAgentRunEvents: vi.fn(),
	reconcileExpiredAgentRun: vi.fn(),
	snapshotFromRun: vi.fn((run: { state?: string; answerText?: string; errorMessage?: string | null }) => ({
		state: run.state || 'researching',
		answerText: run.answerText || '',
		sources: [],
		citations: [],
		tools: [],
		errorMessage: run.errorMessage || null
	}))
}));

vi.mock('$lib/server/db/agent-runs', () => ({
	...dbMocks,
	AGENT_RECOVERY_GRACE_MS: 45_000,
	AGENT_TERMINAL_STATES: ['cancelled', 'failed', 'complete']
}));
vi.mock('$lib/server/chat-diagnostics', () => ({ recordChatDiagnostic: vi.fn() }));
vi.mock('$lib/server/durable-run-telemetry', () => ({ traceIdFromAgentInput: vi.fn(() => null) }));

const {
	AGENT_SUBSCRIPTION_ACTIVE_POLL_MS,
	AGENT_SUBSCRIPTION_HEARTBEAT_MS,
	AGENT_SUBSCRIPTION_MAX_POLL_MS,
	agentSubscriptionResponse,
	nextAgentSubscriptionPollMs
} = await import('./agent-subscription');

const initialRun = {
	id: 'run-1',
	conversationId: 'conversation-1',
	assistantMessageId: 'assistant-1',
	state: 'researching',
	cursor: 0,
	inputJson: '{}'
};

describe('Agent subscription polling', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('backs off when idle and resets when an event arrives', () => {
		let pollMs = AGENT_SUBSCRIPTION_ACTIVE_POLL_MS;
		expect(AGENT_SUBSCRIPTION_MAX_POLL_MS).toBe(500);
		pollMs = nextAgentSubscriptionPollMs(pollMs, false);
		expect(pollMs).toBe(AGENT_SUBSCRIPTION_MAX_POLL_MS);
		expect(nextAgentSubscriptionPollMs(pollMs, false)).toBe(AGENT_SUBSCRIPTION_MAX_POLL_MS);
		expect(nextAgentSubscriptionPollMs(pollMs, true)).toBe(AGENT_SUBSCRIPTION_ACTIVE_POLL_MS);
	});

	it('sends a comment heartbeat after the snapshot and again after 10 s of inactivity', async () => {
		vi.useFakeTimers();
		dbMocks.getAgentRun.mockResolvedValue(initialRun);
		dbMocks.getAgentRunSubscriptionState.mockResolvedValue(initialRun);
		dbMocks.listKnownAgentRunEvents.mockResolvedValue([]);
		const request = new Request('http://localhost/api/chat/runs/run-1');
		const response = await agentSubscriptionResponse({ request, accountId: 'account-1', runId: 'run-1', afterCursor: 0 });
		expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		let pending: Promise<void> | null = null;
		const pump = () => {
			pending = reader.read().then((r) => {
				pending = null;
				if (r.done) return;
				text += decoder.decode(r.value);
				pump();
			});
		};
		const drain = async () => {
			if (!pending) pump();
			await vi.advanceTimersByTimeAsync(0);
		};
		await drain();
		expect(text).toContain('event: run.snapshot');
		expect(text.split(': ping\n\n')).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(AGENT_SUBSCRIPTION_HEARTBEAT_MS + AGENT_SUBSCRIPTION_MAX_POLL_MS);
		await drain();
		expect(text.split(': ping\n\n').length).toBeGreaterThanOrEqual(3);
		await reader.cancel();
	});

	it('stops polling when the response reader disconnects without aborting the request', async () => {
		vi.useFakeTimers();
		dbMocks.getAgentRun.mockResolvedValue(initialRun);
		dbMocks.getAgentRunSubscriptionState.mockResolvedValue(initialRun);
		dbMocks.listKnownAgentRunEvents.mockResolvedValue([]);
		const request = new Request('http://localhost/api/chat/runs/run-1');
		const response = await agentSubscriptionResponse({ request, accountId: 'account-1', runId: 'run-1', afterCursor: 0 });
		const reader = response.body!.getReader();
		await reader.read();
		await vi.advanceTimersByTimeAsync(0);
		await reader.cancel();
		expect(request.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(dbMocks.listKnownAgentRunEvents).toHaveBeenCalledTimes(1);
		expect(dbMocks.getAgentRunSubscriptionState).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('uses four tenant-bound reads for two poll cycles instead of seven', async () => {
		vi.useFakeTimers();
		dbMocks.getAgentRun.mockResolvedValue(initialRun);
		dbMocks.getAgentRunSubscriptionState.mockResolvedValue({ state: 'complete', cursor: 1 });
		dbMocks.listKnownAgentRunEvents
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ cursor: 1, eventType: 'response.completed', dataJson: '{"ok":true}' }
			]);

		const response = await agentSubscriptionResponse({
			request: new Request('http://localhost/api/chat/runs/run-1'),
			accountId: 'account-1',
			runId: 'run-1',
			afterCursor: 0
		});
		const bodyPromise = response.text();
		await vi.advanceTimersByTimeAsync(0);

		expect(dbMocks.getAgentRun).toHaveBeenCalledTimes(1);
		expect(dbMocks.listKnownAgentRunEvents).toHaveBeenCalledTimes(1);
		expect(dbMocks.getAgentRunSubscriptionState).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(AGENT_SUBSCRIPTION_ACTIVE_POLL_MS - 1);
		expect(dbMocks.getAgentRunSubscriptionState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		const body = await bodyPromise;
		expect(dbMocks.getAgentRun).toHaveBeenCalledTimes(1);
		expect(dbMocks.getAgentRunSubscriptionState).toHaveBeenCalledTimes(1);
		expect(dbMocks.listKnownAgentRunEvents).toHaveBeenCalledTimes(2);
		expect(body).toContain('event: response.completed');
	});

	it.each([0, 44_999])('leaves an expired worker lease reclaimable at %i ms after expiry', async elapsedMs => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(5_000 + elapsedMs));
		dbMocks.getAgentRun.mockResolvedValue({ ...initialRun, leaseExpiresAt: 5_000 });
		dbMocks.getAgentRunSubscriptionState.mockResolvedValue({ state: 'complete', cursor: 1 });
		dbMocks.listKnownAgentRunEvents
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ cursor: 1, eventType: 'response.completed', dataJson: '{}' }]);

		const response = await agentSubscriptionResponse({
			request: new Request('http://localhost/api/chat/runs/run-1'),
			accountId: 'account-1', runId: 'run-1', afterCursor: 0
		});
		const bodyPromise = response.text();
		await vi.advanceTimersByTimeAsync(AGENT_SUBSCRIPTION_ACTIVE_POLL_MS);
		const body = await bodyPromise;

		expect(dbMocks.reconcileExpiredAgentRun).not.toHaveBeenCalled();
		expect(body).toContain('status":"researching"');
		expect(body).toContain('event: response.completed');
		expect(body).not.toContain('event: run.failed');
	});

	it('reconciles a leased run exactly when its recovery grace ends before streaming its terminal event', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(50_000));
		const staleRun = {
			...initialRun,
			state: 'researching',
			cursor: 0,
			leaseOwner: 'worker-a',
			leaseToken: 'lease-a',
			leaseExpiresAt: 5_000
		};
		const reconciledRun = {
			...staleRun,
			state: 'failed',
			cursor: 1,
			leaseOwner: null,
			leaseToken: null,
			leaseExpiresAt: null,
			errorMessage: 'Research stopped before it finished. Please try again.'
		};
		dbMocks.getAgentRun.mockResolvedValue(staleRun);
		dbMocks.reconcileExpiredAgentRun.mockResolvedValue(reconciledRun);
		dbMocks.listKnownAgentRunEvents.mockResolvedValue([
			{ cursor: 1, eventType: 'run.failed', dataJson: '{"failure_class":"timeout"}' }
		]);

		const response = await agentSubscriptionResponse({
			request: new Request('http://localhost/api/chat/runs/run-1'),
			accountId: 'account-1',
			runId: 'run-1',
			afterCursor: 0
		});
		const body = await response.text();

		expect(dbMocks.reconcileExpiredAgentRun).toHaveBeenCalledWith('account-1', 'run-1');
		expect(dbMocks.getAgentRunSubscriptionState).not.toHaveBeenCalled();
		expect(body).toContain('status":"failed"');
		expect(body).toContain('Research stopped before it finished. Please try again.');
		expect(body).toContain('event: run.failed');
	});

	it('streams a worker replacement returned by reconciliation without a stale terminal event', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(50_000));
		dbMocks.getAgentRun.mockResolvedValue({ ...initialRun, leaseExpiresAt: 5_000 });
		dbMocks.reconcileExpiredAgentRun.mockResolvedValue({
			...initialRun, leaseOwner: 'worker-new', leaseToken: 'lease-new', leaseExpiresAt: 140_000
		});
		dbMocks.getAgentRunSubscriptionState.mockResolvedValue({ state: 'complete', cursor: 1 });
		dbMocks.listKnownAgentRunEvents
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ cursor: 1, eventType: 'response.completed', dataJson: '{}' }]);
		const response = await agentSubscriptionResponse({
			request: new Request('http://localhost/api/chat/runs/run-1'),
			accountId: 'account-1', runId: 'run-1', afterCursor: 0
		});
		const bodyPromise = response.text();
		await vi.advanceTimersByTimeAsync(AGENT_SUBSCRIPTION_ACTIVE_POLL_MS);
		const body = await bodyPromise;

		expect(dbMocks.reconcileExpiredAgentRun).toHaveBeenCalledOnce();
		expect(body).toContain('status":"researching"');
		expect(body).toContain('event: response.completed');
		expect(body).not.toContain('event: run.failed');
	});
});
