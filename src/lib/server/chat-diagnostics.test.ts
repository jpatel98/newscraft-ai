import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	listPersistedChatDiagnostics: vi.fn(),
	saveChatDiagnostic: vi.fn()
}));

vi.mock('$lib/server/db/chat-diagnostics', () => dbMocks);

import {
	recentChatDiagnostics,
	recentChatDiagnosticsWithPersisted,
	recordChatDiagnostic,
	sanitizeDiagnosticValue
} from './chat-diagnostics';

describe('chat diagnostics', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMocks.listPersistedChatDiagnostics.mockResolvedValue([]);
		dbMocks.saveChatDiagnostic.mockResolvedValue(undefined);
	});

	it('redacts sensitive fields and sensitive-looking text', () => {
		expect(sanitizeDiagnosticValue('authorization', 'Bearer abc123')).toBe('[redacted]');
		expect(
			sanitizeDiagnosticValue(
				'detail',
				'failed with Bearer abc123 and postgres://user:pass@example.com/db and sk-test12345678'
			)
		).toBe(
			'failed with Bearer [redacted] and [redacted-database-url] and [redacted-api-key]'
		);
	});

	it('keeps recent events scoped by conversation', () => {
		recordChatDiagnostic('conversation-a', 'chat.request', { status: 200 });
		recordChatDiagnostic('conversation-b', 'chat.request', { status: 500 });

		expect(recentChatDiagnostics('conversation-a')).toEqual([
			expect.objectContaining({
				conversationId: 'conversation-a',
				type: 'chat.request',
				details: { status: 200 }
			})
		]);
	});

	it('merges persisted diagnostics with in-memory events without duplicates', async () => {
		const persisted = {
			id: 'diag-persisted',
			conversationId: 'conversation-merge',
			type: 'chat.persisted',
			createdAt: 10,
			details: { status: 502 }
		};
		dbMocks.listPersistedChatDiagnostics.mockResolvedValue([
			persisted,
			{
				id: 'diag-duplicate',
				conversationId: 'conversation-merge',
				type: 'chat.duplicate.persisted',
				createdAt: 20,
				details: { source: 'persisted' }
			}
		]);

		recordChatDiagnostic('conversation-merge', 'chat.memory', { status: 200 });
		const memory = recentChatDiagnostics('conversation-merge')[0];
		dbMocks.listPersistedChatDiagnostics.mockResolvedValue([
			persisted,
			{ ...memory, details: { source: 'persisted-copy' } }
		]);

		const merged = await recentChatDiagnosticsWithPersisted('conversation-merge');

		expect(merged.map((event) => event.id)).toEqual([persisted.id, memory.id]);
		expect(merged[1]).toMatchObject({
			id: memory.id,
			type: 'chat.memory',
			details: { status: 200 }
		});
	});
});
