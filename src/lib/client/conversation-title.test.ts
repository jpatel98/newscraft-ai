import { describe, expect, it, vi } from 'vitest';
import {
	needsAutomaticConversationTitle,
	requestAutomaticConversationTitle
} from './conversation-title';

describe('automatic conversation titles', () => {
	it('recognizes only automatic title placeholders', () => {
		expect(needsAutomaticConversationTitle('')).toBe(true);
		expect(needsAutomaticConversationTitle('(untitled)')).toBe(true);
		expect(needsAutomaticConversationTitle('New chat')).toBe(true);
		expect(needsAutomaticConversationTitle('Ontario budget OCVO')).toBe(false);
	});

	it('requests a title for a saved first prompt', async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ title: 'Ontario budget OCVO' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);

		await expect(requestAutomaticConversationTitle('conversation 1', '', fetcher)).resolves.toBe(
			'Ontario budget OCVO'
		);
		expect(fetcher).toHaveBeenCalledWith('/api/conversations/conversation%201/title', {
			method: 'POST'
		});
	});

	it('does not request a replacement for a real or manually edited title', async () => {
		const fetcher = vi.fn();

		await expect(
			requestAutomaticConversationTitle('conversation-1', 'Election night plan', fetcher)
		).resolves.toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
