import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
type Condition = { op: string; column?: string; value?: unknown; parts?: Condition[] };

const state = vi.hoisted(() => ({ rows: [] as Record<string, any>[] }));

vi.mock('drizzle-orm', async (importOriginal) => ({
	...(await importOriginal<typeof import('drizzle-orm')>()),
	eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
	and: (...parts: unknown[]) => ({ op: 'and', parts }),
	isNull: (column: unknown) => ({ op: 'isNull', column }),
	desc: (column: unknown) => ({ op: 'desc', column })
}));

vi.mock('./schema', () => ({
	storyClaims: {
		id: 'id',
		conversationId: 'conversationId',
		supersededBy: 'supersededBy',
		updatedAt: 'updatedAt'
	}
}));

function matches(row: Row, condition: Condition): boolean {
	if (condition.op === 'and') return (condition.parts ?? []).every((part) => matches(row, part));
	if (condition.op === 'eq') return row[condition.column as string] === condition.value;
	if (condition.op === 'isNull') return row[condition.column as string] == null;
	return true;
}

vi.mock('./index', () => {
	const select = () => {
		let condition: Condition = { op: 'true' };
		const chain: any = {
			from: () => chain,
			where: (next: Condition) => ((condition = next), chain),
			orderBy: () => chain,
			limit: async (n: number) =>
				state.rows
					.filter((row) => matches(row, condition))
					.sort((a, b) => b.updatedAt - a.updatedAt)
					.slice(0, n)
					.map((row) => ({ ...row }))
		};
		return chain;
	};
	const fake: any = {
		select,
		insert: () => ({
			values: async (row: Row) => {
				state.rows.push({ ...row });
			}
		}),
		update: () => ({
			set: (patch: Row) => ({
				where: async (condition: Condition) => {
					for (const row of state.rows) if (matches(row, condition)) Object.assign(row, patch);
				}
			})
		}),
		delete: () => ({
			where: async (condition: Condition) => {
				state.rows = state.rows.filter((row) => !matches(row, condition));
			}
		}),
		transaction: async (fn: (tx: unknown) => unknown) => fn(fake)
	};
	return { db: fake };
});

import { deleteStoryClaims, listStoryClaims, reviewStoryClaim, upsertStoryClaims } from './story-claims';

const base = {
	status: 'reported' as const,
	attributedTo: '',
	citations: [] as number[],
	date: '',
	needsCheck: false
};

describe('story claim storage', () => {
	beforeEach(() => {
		state.rows = [];
	});

	it('inserts new claims with first and last seen message ids', async () => {
		const result = await upsertStoryClaims(
			'c1',
			'm1',
			[{ ...base, claim: 'The mayor resigned.', attributedTo: 'City Hall', citations: [2] }],
			1000
		);
		expect(result).toEqual({ inserted: 1, updated: 0 });
		expect(state.rows[0]).toMatchObject({
			conversationId: 'c1',
			claim: 'The mayor resigned.',
			status: 'reported',
			attributedTo: 'City Hall',
			citationNumbers: [2],
			firstSeenMessageId: 'm1',
			lastUpdatedMessageId: 'm1',
			supersededBy: null,
			createdAt: 1000,
			updatedAt: 1000
		});
		expect(typeof state.rows[0].id).toBe('string');
	});

	it('updates an existing claim matched case-insensitively instead of duplicating it', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'The mayor resigned.', attributedTo: 'City Hall' }], 1000);
		const result = await upsertStoryClaims(
			'c1',
			'm2',
			[{ ...base, claim: '  the MAYOR   resigned. ', status: 'confirmed', citations: [4], date: '2026-07-02', needsCheck: true }],
			2000
		);
		expect(result).toEqual({ inserted: 0, updated: 1 });
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0]).toMatchObject({
			claim: 'The mayor resigned.',
			status: 'confirmed',
			attributedTo: 'City Hall',
			citationNumbers: [4],
			publicationDate: '2026-07-02',
			needsCheck: true,
			firstSeenMessageId: 'm1',
			lastUpdatedMessageId: 'm2',
			updatedAt: 2000
		});
	});

	it('creates a new row and marks the old one superseded when the text differs', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'Two soldiers were hurt.' }], 1000);
		const oldId = state.rows[0].id;
		await upsertStoryClaims(
			'c1',
			'm2',
			[{ ...base, claim: 'Three soldiers were hurt.', status: 'confirmed', supersedes: oldId }],
			2000
		);
		expect(state.rows).toHaveLength(2);
		const replacement = state.rows.find((row) => row.claim === 'Three soldiers were hurt.')!;
		expect(state.rows.find((row) => row.id === oldId)!.supersededBy).toBe(replacement.id);
		expect(replacement.supersededBy).toBeNull();
		const listed = await listStoryClaims('c1');
		expect(listed.map((row) => row.claim)).toEqual(['Three soldiers were hurt.']);
	});

	it('updates in place when supersedes names a claim with identical text', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'Same text.' }], 1000);
		const id = state.rows[0].id;
		await upsertStoryClaims('c1', 'm2', [{ ...base, claim: 'same text.', status: 'retracted', supersedes: id }], 2000);
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0]).toMatchObject({ id, status: 'retracted', supersededBy: null });
	});

	it('repoints supersession at an existing text match instead of inserting a duplicate', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'Old.' }, { ...base, claim: 'New.' }], 1000);
		const oldId = state.rows.find((row) => row.claim === 'Old.')!.id;
		const newId = state.rows.find((row) => row.claim === 'New.')!.id;
		await upsertStoryClaims('c1', 'm2', [{ ...base, claim: 'New.', supersedes: oldId }], 2000);
		expect(state.rows).toHaveLength(2);
		expect(state.rows.find((row) => row.id === oldId)!.supersededBy).toBe(newId);
	});

	it('lists live claims newest first and scopes by conversation', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'First.' }], 1000);
		await upsertStoryClaims('c1', 'm2', [{ ...base, claim: 'Second.' }], 2000);
		await upsertStoryClaims('c2', 'm3', [{ ...base, claim: 'Elsewhere.' }], 3000);
		expect((await listStoryClaims('c1')).map((row) => row.claim)).toEqual(['Second.', 'First.']);
		expect((await listStoryClaims('c2')).map((row) => row.claim)).toEqual(['Elsewhere.']);
	});

	it('ignores an empty batch and can delete one conversation ledger', async () => {
		expect(await upsertStoryClaims('c1', 'm1', [])).toEqual({ inserted: 0, updated: 0 });
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'A.' }]);
		await upsertStoryClaims('c2', 'm1', [{ ...base, claim: 'B.' }]);
		await deleteStoryClaims('c1');
		expect(state.rows.map((row) => row.conversationId)).toEqual(['c2']);
	});
	it('records a person\'s review of a live claim in its own conversation only', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'The bridge closed.', needsCheck: true }], 1000);
		const id = state.rows[0].id;
		expect(await reviewStoryClaim('c2', id, { needsCheck: false }, 'Jigar', 2000)).toBeNull();
		expect(await reviewStoryClaim('c1', 'missing', { needsCheck: false }, 'Jigar', 2000)).toBeNull();
		const row = await reviewStoryClaim('c1', id, { needsCheck: false, status: 'confirmed' }, 'Jigar', 3000);
		expect(row).toMatchObject({ id, status: 'confirmed', needsCheck: false, reviewedBy: 'Jigar', reviewedAt: 3000, updatedAt: 3000 });
		expect(state.rows[0]).toMatchObject({ status: 'confirmed', needsCheck: false, reviewedBy: 'Jigar', reviewedAt: 3000 });
	});

	it('keeps a reviewed claim\'s status and flag when a later answer repeats or supersedes it', async () => {
		await upsertStoryClaims('c1', 'm1', [{ ...base, claim: 'The bridge closed.', needsCheck: true }], 1000);
		const id = state.rows[0].id;
		await reviewStoryClaim('c1', id, { needsCheck: false, status: 'confirmed' }, 'Jigar', 2000);

		await upsertStoryClaims('c1', 'm2', [{ ...base, claim: 'The bridge closed.', status: 'reported', needsCheck: true, citations: [3] }], 3000);
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0]).toMatchObject({ status: 'confirmed', needsCheck: false, citationNumbers: [3], reviewedBy: 'Jigar' });

		await upsertStoryClaims('c1', 'm3', [{ ...base, claim: 'The bridge reopened.', supersedes: id }], 4000);
		expect(state.rows).toHaveLength(2);
		expect(state.rows.find((row) => row.id === id)!.supersededBy).toBeNull();
	});
});
