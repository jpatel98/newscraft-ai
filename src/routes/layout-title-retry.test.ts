import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sidebar title retry affordance', () => {
	it('offers retry only for stale automatic titles', () => {
		const source = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');

		expect(source).toContain('function canRetryTitle(c: SidebarConvo): boolean');
		expect(source).toContain("title === '(untitled)' || title === 'new chat'");
		expect(source).toContain('Date.now() - c.updatedAt > 60_000');
		expect(source).toContain('onclick={() => retryTitle(c)}');
		expect(source).toContain(`/api/conversations/\${c.id}/title`);
	});
});
