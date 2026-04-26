import { describe, it, expect } from 'vitest';
import {
	dedupeByConversation,
	matchesAllTokens,
	searchTokens,
	type SearchRow
} from './search-dedupe';

function row(partial: Partial<SearchRow>): SearchRow {
	return {
		conversationId: 'c1',
		conversationTitle: 'Untitled',
		messageId: 'm1',
		role: 'assistant',
		snippet: 'snippet',
		createdAt: 0,
		...partial
	};
}

describe('dedupeByConversation', () => {
	it('keeps a single row per conversation', () => {
		const rows = [
			row({ conversationId: 'c1', messageId: 'm1', createdAt: 1 }),
			row({ conversationId: 'c1', messageId: 'm2', createdAt: 2 }),
			row({ conversationId: 'c2', messageId: 'm3', createdAt: 3 })
		];
		expect(dedupeByConversation(rows)).toHaveLength(2);
	});

	it('prefers the title (thread) hit over message hits', () => {
		const rows = [
			row({ conversationId: 'c1', messageId: 'mX', role: 'user', createdAt: 100 }),
			row({ conversationId: 'c1', messageId: '', role: 'thread', createdAt: 50 })
		];
		const out = dedupeByConversation(rows);
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe('thread');
	});

	it('keeps the most recent message hit when no title hit exists', () => {
		const rows = [
			row({ conversationId: 'c1', messageId: 'm1', createdAt: 5 }),
			row({ conversationId: 'c1', messageId: 'm2', createdAt: 50 }),
			row({ conversationId: 'c1', messageId: 'm3', createdAt: 25 })
		];
		const out = dedupeByConversation(rows);
		expect(out).toHaveLength(1);
		expect(out[0].messageId).toBe('m2');
	});

	it('preserves first-seen order across conversations', () => {
		const rows = [
			row({ conversationId: 'c1', createdAt: 1 }),
			row({ conversationId: 'c2', createdAt: 2 }),
			row({ conversationId: 'c3', createdAt: 3 })
		];
		const out = dedupeByConversation(rows);
		expect(out.map((r) => r.conversationId)).toEqual(['c1', 'c2', 'c3']);
	});

	it('is deterministic for identical inputs', () => {
		const rows = [
			row({ conversationId: 'c1', messageId: 'a', createdAt: 1 }),
			row({ conversationId: 'c1', messageId: 'b', createdAt: 1 })
		];
		const a = dedupeByConversation(rows);
		const b = dedupeByConversation(rows);
		expect(a).toEqual(b);
	});
});

describe('searchTokens', () => {
	it('lowercases and trims tokens', () => {
		expect(searchTokens('  Toronto  Budget ')).toEqual(['toronto', 'budget']);
	});
	it('returns [] for empty input', () => {
		expect(searchTokens('   ')).toEqual([]);
	});
});

describe('matchesAllTokens', () => {
	it('matches a thread title containing every token', () => {
		expect(matchesAllTokens('Toronto budget review', ['toronto', 'budget'])).toBe(true);
	});
	it('rejects when any token is missing', () => {
		expect(matchesAllTokens('Toronto research', ['toronto', 'budget'])).toBe(false);
	});
	it('matches a message body that contains the token', () => {
		const body = "Here's the Q3 budget breakdown for Toronto.";
		expect(matchesAllTokens(body, ['budget'])).toBe(true);
		expect(matchesAllTokens(body, ['toronto'])).toBe(true);
	});
});
