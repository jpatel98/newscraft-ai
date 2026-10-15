import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, ensureMigrated } from './index';
import { splitMigrationStatements } from './migration-runner';
import { listStoryClaimEvents, listStoryClaims, reviewStoryClaim, upsertStoryClaims } from './story-claims';
import type { ClaimJudge } from '$lib/utils/claim-matcher';
import type { LedgerClaim } from '$lib/utils/story-ledger';

const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
const claim = (text: string, over: Partial<LedgerClaim> = {}): LedgerClaim => ({
	claim: text, status: 'reported', attributedTo: '', citations: [], date: '', needsCheck: false, ...over
});
const sameJudge: ClaimJudge = async (pairs) => new Map(pairs.map((pair) => [pair.id, 'same' as const]));

describe.skipIf(!url)('story ledger event log (Postgres)', () => {
	const account = `ledger-${Date.now()}`;
	const convo = `ledger-c-${Date.now()}`;

	beforeAll(async () => {
		await ensureMigrated();
		await sql`INSERT INTO accounts (id,email,name,role,created_at,updated_at) VALUES (${account},${account + '@example.test'},'Ledger test','member',1,1)`;
		await sql`INSERT INTO conversations (id,account_id,title,created_at,updated_at) VALUES (${convo},${account},'Ledger',1,1)`;
	});
	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${account}`;
		await sql.end({ timeout: 1 });
	});

	it('merges a paraphrase into one claim with events and wordings', async () => {
		await upsertStoryClaims(convo, null, [claim('Chow did not say what the expansion would cost', { citations: [1], needsCheck: true })], 10, sameJudge);
		const result = await upsertStoryClaims(convo, null, [claim('Chow has not put a dollar figure on the expansion', { citations: [2] })], 20, sameJudge);
		expect(result).toMatchObject({ inserted: 0, updated: 1, judgeAvailable: true });
		const claims = await listStoryClaims(convo);
		expect(claims).toHaveLength(1);
		expect(claims[0].citationNumbers).toEqual([1, 2]);
		expect(claims[0].needsCheck).toBe(false);
		const events = await listStoryClaimEvents(convo);
		expect(events.map((e) => e.kind)).toEqual(['asserted', 'check_opened', 'asserted', 'check_closed']);
		const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM story_claim_variants WHERE claim_id = ${claims[0].id}`;
		expect(count).toBe(2);
	});

	it('records a person review as events and keeps it against later model turns', async () => {
		const [row] = await listStoryClaims(convo);
		await reviewStoryClaim(convo, row.id, { status: 'confirmed' }, 'Jigar', 30);
		await upsertStoryClaims(convo, null, [claim('Chow did not say what the expansion would cost', { status: 'unverified', needsCheck: true })], 40, sameJudge);
		const [after] = await listStoryClaims(convo);
		expect(after).toMatchObject({ status: 'confirmed', needsCheck: false, reviewedBy: 'Jigar' });
		const kinds = (await listStoryClaimEvents(convo)).map((e) => `${e.kind}:${e.actor}`);
		expect(kinds.slice(-2)).toEqual(['status_changed:person', 'asserted:model']);
	});

	it('refuses to edit or delete events directly', async () => {
		await expect(sql`UPDATE story_claim_events SET kind = 'retracted' WHERE conversation_id = ${convo}`).rejects.toThrow(/append-only/);
		await expect(sql`DELETE FROM story_claim_events WHERE conversation_id = ${convo}`).rejects.toThrow(/append-only/);
	});

	it('still deletes a whole chat, events included', async () => {
		const other = `${convo}-gone`;
		await sql`INSERT INTO conversations (id,account_id,title,created_at,updated_at) VALUES (${other},${account},'Gone',1,1)`;
		await upsertStoryClaims(other, null, [claim('A fact')], 1, null);
		await sql`DELETE FROM conversations WHERE id = ${other}`;
		const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM story_claim_events WHERE conversation_id = ${other}`;
		expect(count).toBe(0);
	});

	it('rolls back and re-applies cleanly, backfilling from story_claims', async () => {
		const down = await readFile(new URL('../../../../drizzle/rollback/0022_story_claim_events.down.sql', import.meta.url), 'utf8');
		const up = await readFile(new URL('../../../../drizzle/0022_story_claim_events.sql', import.meta.url), 'utf8');
		await sql.begin((tx) => tx.unsafe(down));
		const [{ exists }] = await sql<{ exists: boolean }[]>`SELECT to_regclass('story_claim_events') IS NOT NULL AS exists`;
		expect(exists).toBe(false);
		// The canonical rows (and so the API) are untouched by the rollback.
		expect(await listStoryClaims(convo)).toHaveLength(1);
		for (const statement of splitMigrationStatements(up)) await sql.unsafe(statement);
		await sql`INSERT INTO newscraft_schema_migrations (version) VALUES ('0022_story_claim_events')`;
		const kinds = (await listStoryClaimEvents(convo)).map((e) => `${e.kind}:${e.actor}`);
		expect(kinds).toEqual(['asserted:model', 'status_changed:person']);
		// Re-running the backfill is a no-op.
		for (const statement of splitMigrationStatements(up)) await sql.unsafe(statement);
		expect(await listStoryClaimEvents(convo)).toHaveLength(2);
	});
});
