import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMocks = vi.hoisted(() => ({ getConversationLoad: vi.fn() }));
const artifactMocks = vi.hoisted(() => ({ listArtifactSummariesForMessages: vi.fn() }));
const runMocks = vi.hoisted(() => ({
	getActiveHermesRun: vi.fn(),
	listHermesRunsForConversation: vi.fn(),
	listHermesRunStatesForMessages: vi.fn(),
	snapshotFromRun: vi.fn(() => ({
		state: 'writing',
		answerText: 'Saved answer',
		sources: [{ id: 'source-1', url: 'https://example.test', title: 'Example', status: 'used', domain: 'example.test', firstSeenAt: 1, lastSeenAt: 1, used: true }],
		citations: [],
		tools: [],
		errorMessage: null
	}))
}));

vi.mock('$lib/server/db/conversation-load', () => loadMocks);
vi.mock('$lib/server/db/artifacts', () => artifactMocks);
vi.mock('$lib/server/db/hermes-runs', () => runMocks);

import { load } from './+page.server';

describe('conversation durable run load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		artifactMocks.listArtifactSummariesForMessages.mockResolvedValue([]);
	});
	const base = () => ({
		conversation: { id: 'conversation-1', title: 'Thread', updatedAt: 7 },
		messages: [], totalCount: 0, activeRun: null, durableRuns: [],
		actionSummary: { latestUser: null, latestAssistant: null, latestReadyAssistant: null, latestUnfinishedAssistant: null }
	});
	const event = { params: { id: 'conversation-1' }, locals: { user: { id: 'account-1' } } };

	it('returns the account-scoped active run snapshot for refresh recovery', async () => {
		loadMocks.getConversationLoad.mockResolvedValue({ ...base(), activeRun: {
			id: 'run-1', conversationId: 'conversation-1', assistantMessageId: 'assistant-1', cursor: 4, state: 'writing'
		} });
		const result = await load(event as any) as any;
		expect(loadMocks.getConversationLoad).toHaveBeenCalledExactlyOnceWith('account-1', 'conversation-1', 50);
		expect(result.durableRun).toMatchObject({ id: 'run-1', cursor: 4, status: 'writing', answerText: 'Saved answer' });
	});

	it('attaches terminal state and preserves the chat when optional artifacts fail', async () => {
		loadMocks.getConversationLoad.mockResolvedValue({ ...base(), totalCount: 1,
			messages: [{ id: 'assistant-1', role: 'assistant', content: 'Partial answer', toolCalls: null, partial: 1, createdAt: 6 }],
			durableRuns: [{ assistantMessageId: 'assistant-1', state: 'cancelled', errorMessage: null }]
		});
		artifactMocks.listArtifactSummariesForMessages.mockRejectedValue(new Error('unavailable'));
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await load(event as any) as any;
			expect(result.messages[0]).toMatchObject({ durableState: 'cancelled', durableError: null });
		} finally { warning.mockRestore(); }
	});

	it('returns 404 without loading artifacts when ownership is absent', async () => {
		loadMocks.getConversationLoad.mockResolvedValue(null);
		await expect(load(event as any)).rejects.toMatchObject({ status: 404 });
		expect(artifactMocks.listArtifactSummariesForMessages).not.toHaveBeenCalled();
	});
	it('rejects an unauthenticated request before querying', async () => {
		await expect(load({ ...event, locals: {} } as any)).rejects.toMatchObject({ status: 401 });
		expect(loadMocks.getConversationLoad).not.toHaveBeenCalled();
	});
});
