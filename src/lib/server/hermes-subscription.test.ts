import { afterEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	getHermesRun: vi.fn(),
	getHermesRunSubscriptionState: vi.fn(),
	listKnownHermesRunEvents: vi.fn(),
	snapshotFromRun: vi.fn(() => ({
		state: 'researching',
		answerText: '',
		sources: [],
		citations: [],
		tools: [],
		errorMessage: null
	}))
}));

vi.mock('$lib/server/db/hermes-runs', () => ({
	...dbMocks,
	HERMES_TERMINAL_STATES: ['cancelled', 'failed', 'complete']
}));
vi.mock('$lib/server/chat-diagnostics', () => ({ recordChatDiagnostic: vi.fn() }));
vi.mock('$lib/server/durable-run-telemetry', () => ({ traceIdFromHermesInput: vi.fn(() => null) }));

const {
	HERMES_SUBSCRIPTION_ACTIVE_POLL_MS,
	HERMES_SUBSCRIPTION_MAX_POLL_MS,
	hermesSubscriptionResponse,
	nextHermesSubscriptionPollMs
} = await import('./hermes-subscription');

const initialRun = {
	id: 'run-1',
	conversationId: 'conversation-1',
	assistantMessageId: 'assistant-1',
	state: 'researching',
	cursor: 0,
	inputJson: '{}'
};

describe('Hermes subscription polling', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('backs off when idle and resets when an event arrives', () => {
		let pollMs = HERMES_SUBSCRIPTION_ACTIVE_POLL_MS;
		pollMs = nextHermesSubscriptionPollMs(pollMs, false);
		expect(pollMs).toBe(500);
		pollMs = nextHermesSubscriptionPollMs(pollMs, false);
		expect(pollMs).toBe(1_000);
		pollMs = nextHermesSubscriptionPollMs(pollMs, false);
		expect(pollMs).toBe(HERMES_SUBSCRIPTION_MAX_POLL_MS);
		expect(nextHermesSubscriptionPollMs(pollMs, false)).toBe(HERMES_SUBSCRIPTION_MAX_POLL_MS);
		expect(nextHermesSubscriptionPollMs(pollMs, true)).toBe(HERMES_SUBSCRIPTION_ACTIVE_POLL_MS);
	});

	it('uses four tenant-bound reads for two poll cycles instead of seven', async () => {
		vi.useFakeTimers();
		dbMocks.getHermesRun.mockResolvedValue(initialRun);
		dbMocks.getHermesRunSubscriptionState.mockResolvedValue({ state: 'complete', cursor: 1 });
		dbMocks.listKnownHermesRunEvents
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ cursor: 1, eventType: 'response.completed', dataJson: '{"ok":true}' }
			]);

		const response = await hermesSubscriptionResponse({
			request: new Request('http://localhost/api/chat/runs/run-1'),
			accountId: 'account-1',
			runId: 'run-1',
			afterCursor: 0
		});
		const bodyPromise = response.text();
		await vi.advanceTimersByTimeAsync(0);

		expect(dbMocks.getHermesRun).toHaveBeenCalledTimes(1);
		expect(dbMocks.listKnownHermesRunEvents).toHaveBeenCalledTimes(1);
		expect(dbMocks.getHermesRunSubscriptionState).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(HERMES_SUBSCRIPTION_ACTIVE_POLL_MS - 1);
		expect(dbMocks.getHermesRunSubscriptionState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		const body = await bodyPromise;
		expect(dbMocks.getHermesRun).toHaveBeenCalledTimes(1);
		expect(dbMocks.getHermesRunSubscriptionState).toHaveBeenCalledTimes(1);
		expect(dbMocks.listKnownHermesRunEvents).toHaveBeenCalledTimes(2);
		expect(body).toContain('event: response.completed');
	});
});
