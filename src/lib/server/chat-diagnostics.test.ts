import { describe, expect, it } from 'vitest';
import {
	recentChatDiagnostics,
	recordChatDiagnostic,
	sanitizeDiagnosticValue
} from './chat-diagnostics';

describe('chat diagnostics', () => {
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
});
