import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	transport: {
		deriveSessionId: vi.fn(), deriveHermesTenantKey: vi.fn(), buildHermesRunInput: vi.fn(),
		startDurableHermesRun: vi.fn(), gatewayHealth: vi.fn()
	},
	conversation: {
		addMessage: vi.fn(), claimPartialAssistantMessage: vi.fn(), createConversation: vi.fn(),
		deleteMessagesFrom: vi.fn(), finalizePreparedAssistantMessage: vi.fn(), finalizeResumedAssistantMessage: vi.fn(),
		getConversation: vi.fn(), getMessageById: vi.fn(), getMessages: vi.fn(), getPreparedDurableTurnStatus: vi.fn(),
		prepareDurableUserTurn: vi.fn(), takeOverPreparedDurableTurn: vi.fn()
	},
	runs: {
		createOrGetHermesRun: vi.fn(), ensureHermesAssistantMessage: vi.fn(), failQueuedHermesRun: vi.fn(),
		getHermesRun: vi.fn(), getHermesRunForAssistant: vi.fn()
	},
	listAgentCommands: vi.fn(), expandAgentSkill: vi.fn(), subscription: vi.fn(), diagnostics: vi.fn(),
	getProvenance: vi.fn(), saveProvenance: vi.fn(), reasoning: vi.fn(), buildContext: vi.fn(),
	listDocuments: vi.fn(), buildDocumentContext: vi.fn()
}));
vi.mock('$lib/server/agent/transport', () => ({ ...mocks.transport, HermesDurableOverloadError: class extends Error {} }));
vi.mock('$lib/server/agent/bridge', () => ({ listAgentCommands: mocks.listAgentCommands, expandAgentSkill: mocks.expandAgentSkill }));
vi.mock('$lib/server/db/conversations', () => ({ ...mocks.conversation, parseContent: (content: string) => content }));
vi.mock('$lib/server/db/hermes-runs', () => ({ ...mocks.runs, HermesRunRepositoryError: class extends Error { code?: string } }));
vi.mock('$lib/server/hermes-subscription', () => ({ hermesSubscriptionResponse: mocks.subscription }));
vi.mock('$lib/server/reasoning', () => ({
	getConversationReasoningEffort: mocks.reasoning, parseReasoningEffort: vi.fn(),
	reasoningEffortLabel: vi.fn(), setConversationReasoningEffort: vi.fn()
}));
vi.mock('$lib/server/chat-diagnostics', () => ({ recordChatDiagnostic: mocks.diagnostics }));
vi.mock('$lib/server/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }) }));
vi.mock('$lib/server/db/message-provenance', () => ({ getConversationMessageProvenance: mocks.getProvenance, saveMessageProvenance: mocks.saveProvenance }));
vi.mock('$lib/server/documents/profiles', () => ({ getNewsroomProfile: vi.fn() }));
vi.mock('$lib/server/documents/runtime', () => ({ getConversationDocumentService: () => ({ listDocuments: mocks.listDocuments, buildContext: mocks.buildDocumentContext }) }));
vi.mock('$lib/server/conversation-context', () => ({ buildConversationContext: mocks.buildContext, conversationContextProvenanceMessageIds: () => [] }));

import { POST } from './+server';
import { POST as createRunAlias } from '../runs/+server';

const conversation = { id: 'conversation-1', accountId: 'account-1', orgId: null, title: '', systemPrompt: null };
const user = { id: 'user-1', conversationId: conversation.id, role: 'user', content: 'Research Ontario transit funding.', partial: 0, toolCalls: null };
const assistant = { id: 'assistant-1', conversationId: conversation.id, role: 'assistant', content: '', partial: 1, toolCalls: null };
const run = {
	id: 'run-1', accountId: 'account-1', conversationId: conversation.id, assistantMessageId: assistant.id,
	tenantKey: 'tenant-1', state: 'queued', createdAt: Date.now(), inputJson: '{}', seededCitationsJson: '[]'
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.conversation.getConversation.mockResolvedValue(conversation);
	mocks.conversation.createConversation.mockResolvedValue(conversation);
	mocks.conversation.getMessages.mockResolvedValue([user, assistant]);
	mocks.conversation.getMessageById.mockResolvedValue(assistant);
	mocks.conversation.claimPartialAssistantMessage.mockResolvedValue(1234);
	mocks.conversation.prepareDurableUserTurn.mockResolvedValue({ user, assistant, created: true, claimToken: 1234 });
	mocks.conversation.addMessage.mockImplementation(async input => ({ ...input, id: input.role === 'user' ? user.id : assistant.id }));
	mocks.conversation.finalizePreparedAssistantMessage.mockResolvedValue(assistant);
	mocks.runs.getHermesRun.mockResolvedValue(null);
	mocks.runs.getHermesRunForAssistant.mockResolvedValue(null);
	mocks.runs.ensureHermesAssistantMessage.mockResolvedValue(assistant.id);
	mocks.runs.createOrGetHermesRun.mockImplementation(async input => ({ created: true, run: { ...run, inputJson: input.inputJson, seededCitationsJson: input.seededCitationsJson } }));
	mocks.runs.failQueuedHermesRun.mockResolvedValue({ ...run, state: 'failed' });
	mocks.transport.deriveSessionId.mockReturnValue('session-1');
	mocks.transport.deriveHermesTenantKey.mockReturnValue('tenant-1');
	mocks.transport.buildHermesRunInput.mockImplementation((body, threadId, runId, options) => ({
		input: { runId, threadId, messages: body.messages, trace_id: options.traceId }, seededCitations: []
	}));
	mocks.transport.startDurableHermesRun.mockResolvedValue({ accepted: true });
	mocks.reasoning.mockResolvedValue('high');
	mocks.getProvenance.mockResolvedValue([]);
	mocks.listDocuments.mockResolvedValue([]);
	mocks.buildContext.mockReturnValue({ recentTurns: [], currentTurn: { researchRequired: true, researchAllowed: true, messageId: user.id, operation: 'send' } });
	mocks.subscription.mockImplementation(async () => new Response('durable-saved-events', { headers: { 'content-type': 'text/event-stream' } }));
});

function event(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	return {
		request: new Request('http://localhost/api/chat/stream', {
			method: 'POST', headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify({ conversation_id: conversation.id, content: user.content, ...body })
		}),
		locals: { user: { id: 'account-1' }, traceId: 'trusted-trace-1234' }, getClientAddress: () => '127.0.0.1'
	} as Parameters<typeof POST>[0];
}

describe('one durable chat path', () => {
	it.each(['a'.repeat(951 * 1024), '字'.repeat(320 * 1024)])('bounds actual request bytes without trusting Content-Length', async content => {
		await expect(POST(event({ content }))).rejects.toMatchObject({ status: 413 });
		expect(mocks.conversation.getConversation).not.toHaveBeenCalled();
		expect(mocks.conversation.prepareDurableUserTurn).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});

	it.each([{ body: null }, { body: [] }, { body: 'message' }])('rejects a non-object JSON body before reading conversation state: %j', async ({ body }) => {
		const input = event();
		input.request = new Request('http://localhost/api/chat/stream', { method: 'POST', body: JSON.stringify(body) });
		await expect(POST(input)).rejects.toMatchObject({ status: 400 });
		expect(mocks.conversation.getConversation).not.toHaveBeenCalled();
		expect(mocks.conversation.createConversation).not.toHaveBeenCalled();
	});

	it.each([
		{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] },
		{ content: [{ type: 'text', text: 'Read this image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }
	])('preserves image-only and mixed attachments in the saved model input', async ({ content }) => {
		mocks.conversation.getMessages.mockResolvedValue([{ ...user, content }, assistant]);
		await POST(event({ content }));
		expect(mocks.conversation.prepareDurableUserTurn).toHaveBeenCalledWith(expect.objectContaining({ content }));
		expect(mocks.transport.startDurableHermesRun.mock.calls[0][0].input.messages)
			.toContainEqual(expect.objectContaining({ role: 'user', content }));
	});

	it.each([
		{ content: [{ type: 'file', url: 'file:///private/key' }] },
		{ content: [{ type: 'image_url', image_url: { url: 'https://example.org/private.png' } }] },
		{ content: [{ type: 'image_url', image_url: {} }] },
		{ content: [null] }
	])('rejects unsupported attachments before preparing a model run', async ({ content }) => {
		await expect(POST(event({ content }))).rejects.toMatchObject({ status: 400 });
		expect(mocks.conversation.prepareDurableUserTurn).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});
	it.each([{} as Record<string, string>, { 'x-newscraft-durable-run': '0' }])('starts a saved run regardless of legacy mode header %j', async headers => {
		const requestEvent = event({}, headers);
		const response = await POST(requestEvent);
		expect(await response.text()).toBe('durable-saved-events');
		expect(mocks.conversation.prepareDurableUserTurn).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-1', content: user.content }));
		expect(mocks.runs.createOrGetHermesRun).toHaveBeenCalledWith(expect.objectContaining({
			accountId: 'account-1', assistantMessageId: assistant.id, preparedClaimToken: 1234,
			tenantKey: 'tenant-1', conversationId: conversation.id
		}));
		expect(mocks.transport.startDurableHermesRun).toHaveBeenCalledTimes(1);
		expect(mocks.subscription).toHaveBeenCalledWith({ request: requestEvent.request, accountId: 'account-1', runId: run.id, afterCursor: 0 });
	});

	it('uses the runs alias without rewriting the request or adding a mode marker', async () => {
		const requestEvent = event();
		await createRunAlias(requestEvent);
		expect(mocks.subscription.mock.calls[0][0].request).toBe(requestEvent.request);
		expect(requestEvent.request.headers.has('x-newscraft-durable-run')).toBe(false);
	});

	it('binds a supplied idempotency key to the saved run and reconnects without preparing another turn', async () => {
		await POST(event({ idempotency_key: 'browser-turn-1' }));
		expect(mocks.runs.createOrGetHermesRun).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'browser-turn-1' }));
		mocks.runs.getHermesRun.mockResolvedValue(run);
		mocks.conversation.prepareDurableUserTurn.mockClear();
		mocks.transport.startDurableHermesRun.mockClear();
		await POST(event({ idempotency_key: 'browser-turn-1' }));
		expect(mocks.runs.getHermesRun).toHaveBeenLastCalledWith('account-1', 'browser-turn-1', 'idempotency');
		expect(mocks.conversation.prepareDurableUserTurn).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});

	it('rejects an idempotency key from another conversation before any model work', async () => {
		mocks.runs.getHermesRun.mockResolvedValue({ ...run, conversationId: 'other-conversation' });
		await expect(POST(event({ idempotency_key: 'browser-turn-1' }))).rejects.toMatchObject({ status: 409 });
		expect(mocks.conversation.prepareDurableUserTurn).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});

	it('restarts an existing queued job using its saved input and trace binding', async () => {
		const savedInput = { runId: run.id, threadId: 'saved-session', trace_id: 'saved-trace-1234', messages: [] };
		mocks.runs.createOrGetHermesRun.mockResolvedValue({ created: false, run: { ...run, inputJson: JSON.stringify(savedInput) } });
		await POST(event());
		expect(mocks.transport.startDurableHermesRun).toHaveBeenCalledWith(expect.objectContaining({ input: savedInput, traceId: 'saved-trace-1234' }));
	});

	it('consumes a partial-answer claim when starting a durable resume', async () => {
		mocks.conversation.getMessageById.mockResolvedValue({ ...assistant, content: 'Saved partial answer.' });
		await POST(event({ resume: true, message_id: assistant.id, content: undefined }));
		expect(mocks.runs.createOrGetHermesRun).toHaveBeenCalledWith(expect.objectContaining({
			assistantMessageId: assistant.id, preparedClaimToken: 1234, seededAnswerText: 'Saved partial answer.'
		}));
		expect(mocks.conversation.prepareDurableUserTurn).not.toHaveBeenCalled();
	});

	it('reconnects to an active answer without taking a new resume claim or spawning work', async () => {
		mocks.runs.getHermesRunForAssistant.mockResolvedValue({ ...run, state: 'writing' });
		await POST(event({ resume: true, message_id: assistant.id, content: undefined }));
		expect(mocks.conversation.claimPartialAssistantMessage).not.toHaveBeenCalled();
		expect(mocks.runs.createOrGetHermesRun).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});

	it('persists a failed startup and subscribes to its recoverable terminal run', async () => {
		mocks.transport.startDurableHermesRun.mockRejectedValue(new Error('worker unavailable'));
		await expect(POST(event())).resolves.toBeInstanceOf(Response);
		expect(mocks.runs.failQueuedHermesRun).toHaveBeenCalledWith('account-1', run.id, undefined, 'start');
		expect(mocks.subscription).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }));
	});

	it('keeps a prepared user request and local failure answer when preflight fails', async () => {
		mocks.reasoning.mockRejectedValue(new Error('settings temporarily unavailable'));
		const response = await POST(event());
		expect(await response.text()).toContain("couldn't start this answer");
		expect(mocks.conversation.finalizePreparedAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
			accountId: 'account-1', conversationId: conversation.id, messageId: assistant.id, claimToken: 1234
		}));
		expect(mocks.runs.createOrGetHermesRun).not.toHaveBeenCalled();
	});

	it('rejects foreign document attachments before preparing or starting a run', async () => {
		await expect(POST(event({ document_ids: ['foreign-document'] }))).rejects.toMatchObject({ status: 404 });
		expect(mocks.listDocuments).toHaveBeenCalledWith('account-1', conversation.id);
		expect(mocks.conversation.prepareDurableUserTurn).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});

	it('rejects unauthenticated requests before database or model work', async () => {
		const requestEvent = event();
		requestEvent.locals.user = null;
		await expect(POST(requestEvent)).rejects.toMatchObject({ status: 401 });
		expect(mocks.conversation.getConversation).not.toHaveBeenCalled();
		expect(mocks.transport.startDurableHermesRun).not.toHaveBeenCalled();
	});
});
