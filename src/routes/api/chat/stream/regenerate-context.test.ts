import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat regeneration context', () => {
	it('persists attached document ids and restores the user query during regeneration', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(source).toContain('toolCalls: serializeUserDocumentIds(documentIds)');
		expect(source).toContain('documentIds = parseUserDocumentIds(latestUserMessage?.toolCalls)');
		expect(source).toContain('query: body.content ? contentText(body.content) : regeneratedUserRequest');
	});
});
