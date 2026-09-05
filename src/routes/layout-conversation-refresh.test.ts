import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversationMocks = vi.hoisted(() => ({ listConversations: vi.fn() }));

vi.mock('$lib/server/db/conversations', () => conversationMocks);

import { CONVERSATIONS_DEPENDENCY } from '$lib/utils/load-dependencies';
import { load } from './+layout.server';

const layoutSource = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');

function functionSource(name: string, nextName: string): string {
	const start = layoutSource.indexOf(`async function ${name}`);
	const asyncEnd = layoutSource.indexOf(`\n\tasync function ${nextName}`, start);
	const syncEnd = layoutSource.indexOf(`\n\tfunction ${nextName}`, start);
	const end =
		asyncEnd < 0 ? syncEnd : syncEnd < 0 ? asyncEnd : Math.min(asyncEnd, syncEnd);
	return layoutSource.slice(start, end < 0 ? undefined : end);
}

describe('sidebar conversation refresh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.listConversations.mockResolvedValue([
			{
				id: 'conversation-1',
				title: 'Story',
				updatedAt: 10,
				pinned: 1,
				systemPrompt: null
			}
		]);
	});

	it('registers a dependency for the account-scoped conversation list', async () => {
		const depends = vi.fn();
		await load({
			locals: { user: { id: 'account-1' }, isMarketingHost: false },
			depends
		} as any);

		expect(depends).toHaveBeenCalledWith(CONVERSATIONS_DEPENDENCY);
		expect(conversationMocks.listConversations).toHaveBeenCalledWith('account-1', 50);
	});

	it('uses only the sidebar dependency for pin and rename mutations', () => {
		const pin = functionSource('togglePin', 'startRename');
		const rename = functionSource('commitRename', 'canRetryTitle');

		expect(pin).toContain('await invalidate(CONVERSATIONS_DEPENDENCY);');
		expect(rename).toContain('await invalidate(CONVERSATIONS_DEPENDENCY);');
		expect(pin).not.toContain('invalidateAll');
		expect(rename).not.toContain('invalidateAll');
		expect(pin).toContain('JSON.stringify({ pinned: next })');
		expect(rename).toContain('JSON.stringify({ title: next })');
	});

	it('keeps full reloads for title retry and deletion flows', () => {
		const retry = functionSource('retryTitle', 'cancelRename');
		const deletion = functionSource('confirmDelete', 'onRowAction');

		expect(retry).toContain('await invalidateAll();');
		expect(deletion).toContain('await invalidateAll();');
	});
});
