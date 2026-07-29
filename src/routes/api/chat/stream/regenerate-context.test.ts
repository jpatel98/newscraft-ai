import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat regeneration context', () => {
	it('persists attached document ids and restores the user query during regeneration or retry', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(source).toContain('toolCalls: serializeUserDocumentIds(documentIds)');
		expect(source).toContain('documentIds = parseUserDocumentIds(latestUserMessage?.toolCalls)');
		expect(source).toContain('isRegenerate || isRetry || isResume');
		expect(source).toContain('query: currentRequest');
		expect(source).toContain('answerForLatestUser(existingMessages)');
		expect(source).toContain("message.role !== 'assistant' || message.partial !== 1");
		expect(source).not.toContain('lastAssistantMessage(convoId)');
		expect(source.indexOf('the saved user request changed before retry')).toBeLessThan(
			source.indexOf('deleteMessagesFrom(convoId, existingAnswer.id)')
		);
	});
});
