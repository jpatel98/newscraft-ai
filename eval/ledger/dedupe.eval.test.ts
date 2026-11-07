import { describe, expect, it } from 'vitest';
import type { ClaimJudge } from '../../src/lib/utils/claim-matcher';
import { planDedupe, type ExportedClaimRow } from './dedupe';

const row = (id: string, claim: string, over: Partial<ExportedClaimRow> = {}): ExportedClaimRow => ({
	id, conversation_id: 'c', claim, status: 'reported', attributed_to: '', citation_numbers: [], publication_date: '',
	needs_check: false, first_seen_message_id: 'm', last_updated_message_id: 'm', superseded_by: null, created_at: Number(id.slice(1)),
	updated_at: 1, ...over
});
const judge: ClaimJudge = async (pairs) =>
	new Map(pairs.map((p) => [p.id, /dollar|cost/.test(p.a) && /dollar|cost/.test(p.b) ? 'same' : /225|222/.test(p.a + p.b) ? 'contradicts' : 'different'] as const));

describe('backfill dedupe plan', () => {
	it('merges paraphrases into the earliest row, links conflicts, and keeps reviewed rows', async () => {
		let n = 0;
		const plan = await planDedupe(
			[
				row('r1', 'Chow did not say what the expansion would cost', { citation_numbers: [1] }),
				row('r2', 'Chow has not put a dollar figure on the expansion', { citation_numbers: [3], needs_check: true }),
				row('r3', 'The City says 222,550 advance votes were cast'),
				row('r4', 'CP24 reports 225,550 advance voters'),
				row('r5', 'Chow did not give a cost figure', { reviewed_at: 9, reviewed_by: 'Jigar' })
			],
			judge,
			100,
			() => `id${++n}`
		);
		expect(plan.merges.map((m) => [m.from, m.into])).toEqual([['r2', 'r1']]);
		expect(plan.conflicts.map((c) => [c.a, c.b])).toEqual([['r3', 'r4']]);
		const sql = plan.statements.join('\n');
		expect(sql).toContain("UPDATE story_claims SET superseded_by = 'r1'");
		expect(sql).toContain('"merged_from":"r2"');
		expect(sql).toContain("citation_numbers = '[1,3]'::jsonb");
		expect(sql).not.toContain("WHERE id = 'r5'");
	});

	it('escapes quotes in claim text', async () => {
		const plan = await planDedupe([row('r1', "O'Toole's cost claim"), row('r2', "O'Toole's dollar claim")], judge, 1, () => 'x');
		expect(plan.statements.join('\n')).toContain("'O''Toole''s");
	});

	it.each([false, true])('keeps conflict checks open after a duplicate with an initial model flag of %s', async (needsCheck) => {
		let sequence = 0;
		const plan = await planDedupe([
			row('r1', 'The City says 222,550 advance votes were cast', { needs_check: needsCheck }),
			row('r2', 'CP24 reports 225,550 advance voters'),
			row('r3', 'The City says 222,550 advance votes were cast')
		], judge, 100, () => `event${++sequence}`);
		const sql = plan.statements.join('\n');
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.merges.map((merge) => [merge.from, merge.into])).toEqual([['r3', 'r1']]);
		for (const claimId of ['r1', 'r2']) {
			expect(sql).toContain(`'${claimId}', 'check_opened'`);
			expect(sql).toContain(`UPDATE story_claims SET needs_check = true, check_reason = 'contradicted', updated_at = 100 WHERE id = '${claimId}'`);
		}
		expect(sql).not.toContain("'check_closed'");
		expect(sql).not.toContain('needs_check = false');
	});

	it('does not reopen a person-reviewed row when backfilling a conflict', async () => {
		const plan = await planDedupe([
			row('r1', 'The City says 222,550 advance votes were cast', { reviewed_at: 9, reviewed_by: 'Jigar' }),
			row('r2', 'CP24 reports 225,550 advance voters')
		], judge, 100, () => 'event');
		const sql = plan.statements.join('\n');
		expect(sql).toContain("'r1', 'contradicted'");
		expect(sql).not.toContain("'r1', 'check_opened'");
		expect(sql).not.toContain("WHERE id = 'r1'");
		expect(sql).toContain("'r2', 'check_opened'");
	});
});
