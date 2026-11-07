import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ where: [] as unknown[] }));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('./index', () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: (condition: unknown) => { captured.where.push(condition); return chain; },
		orderBy: () => chain,
		limit: async () => []
	};
	return { db: chain, sql: Object.assign(async () => [], { begin: async () => undefined }), ensureMigrated: async () => undefined, DEFAULT_ORGANIZATION_ID: 'org_default' };
});

import { listRecentConversationSubjects } from './conversations';

/** Flatten a drizzle SQL tree into the column names and bound values it references. */
function sqlText(condition: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	const walk = (value: unknown) => {
		if (value === null || value === undefined) return;
		if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return; }
		if (typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const record = value as Record<string, unknown>;
		if (typeof record.name === 'string' && 'table' in record) { parts.push(record.name); return; }
		if (Array.isArray(record.queryChunks)) { for (const chunk of record.queryChunks) walk(chunk); return; }
		if ('value' in record && !('queryChunks' in record)) { walk(record.value); return; }
	};
	walk(condition);
	return parts.join(' ');
}

describe('recent conversation subjects', () => {
	it('binds the thread-title context to the account as well as the organization', async () => {
		await listRecentConversationSubjects('acct-1', 'org-1', 100, 'conv-1');
		const predicate = sqlText(captured.where.at(-1));
		expect(predicate).toContain('account_id');
		expect(predicate).toContain('org_id');
		expect(predicate).toContain('acct-1');
		expect(predicate).toContain('org-1');
	});
});
