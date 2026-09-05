import { describe, expect, it } from 'vitest';
import { selectConversationDisplayTitle } from './conversation-title-display';

describe('conversation title display synchronization', () => {
	it('uses the refreshed active sidebar title after a successful rename', () => {
		expect(selectConversationDisplayTitle('Old title', 'Renamed title', null)).toBe('Renamed title');
	});

	it('does not let an unrelated conversation rename change the active title', () => {
		expect(selectConversationDisplayTitle('Active title', 'Active title', null)).toBe('Active title');
	});

	it('keeps the server-confirmed title after a failed patch', () => {
		expect(selectConversationDisplayTitle('Active title', 'Active title', null)).toBe('Active title');
	});

	it('keeps an automatic stream title while the server still has a placeholder', () => {
		expect(selectConversationDisplayTitle('(untitled)', '(untitled)', 'Live title')).toBe('Live title');
	});

	it('lets a server-confirmed rename win over an automatic stream title', () => {
		expect(selectConversationDisplayTitle('(untitled)', 'Editor title', 'Live title')).toBe('Editor title');
	});
});
