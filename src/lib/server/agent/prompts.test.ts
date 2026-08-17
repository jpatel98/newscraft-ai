import { describe, expect, it } from 'vitest';
import {
	NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL,
	resolveConversationSystemPrompt
} from './prompts';

describe('NewsCraft Hermes prompt composition', () => {
	it('keeps retrieval mechanics without creating a second product identity', () => {
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).toContain('verify_this_lead');
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).toContain(
			'Search snippets and search result pages are leads, not evidence'
		);
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).toContain('publication or update date');
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).toContain(
			'citation marker at the end of a clear claim group or paragraph'
		);
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).not.toContain('You are Hermes');
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).not.toContain(
			'next to every factual claim'
		);
		expect(NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL).not.toMatch(/(?:exactly|at least|top) \d+ (?:stories|items)/i);
	});

	it('keeps optional thread overrides explicit and normalized', () => {
		expect(resolveConversationSystemPrompt('  Use a table.  ')).toBe('Use a table.');
		expect(resolveConversationSystemPrompt('   ')).toBeNull();
		expect(resolveConversationSystemPrompt(null)).toBeNull();
		expect(resolveConversationSystemPrompt(undefined)).toBeNull();
	});
});
