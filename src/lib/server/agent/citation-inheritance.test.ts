import { describe, expect, it } from 'vitest';
import { selectCitationInheritanceToolCalls } from './citation-inheritance';

describe('citation inheritance', () => {
	it('resumes with the partial answer source instead of an older citation with the same number', () => {
		const messages = [
			{ id: 'completed-y', toolCalls: '{"citations":[{"citationNumber":1,"url":"source-y"}]}' },
			{ id: 'partial-x', toolCalls: '{"citations":[{"citationNumber":1,"url":"source-x"}]}' }
		];

		const selected = selectCitationInheritanceToolCalls({ messages, resumeMessageId: 'partial-x' });
		expect(selected).toContain('source-x');
		expect(selected).not.toContain('source-y');
	});

	it('does not select raw prior metadata for a normal turn', () => {
		const messages = [{ id: 'completed-y', toolCalls: '{"citations":[{"citationNumber":1}]}' }];

		expect(selectCitationInheritanceToolCalls({ messages })).toBeNull();
	});
});
