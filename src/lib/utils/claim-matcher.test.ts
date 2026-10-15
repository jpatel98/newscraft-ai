import { describe, expect, it } from 'vitest';
import { foldClaim, type ClaimState } from './claim-events';
import { matchIncoming, type ClaimJudge, type JudgeVerdict } from './claim-matcher';
import { embedClaim, cosine, normalizeClaimText } from './claim-similarity';
import type { LedgerClaim } from './story-ledger';

function state(id: string, text: string): ClaimState {
	return foldClaim(id, [{ claimId: id, kind: 'asserted', actor: 'model', actorName: '', messageId: 'm', data: { text, status: 'reported' }, at: 1 }]);
}
function claim(text: string, over: Partial<LedgerClaim> = {}): LedgerClaim {
	return { claim: text, status: 'reported', attributedTo: '', citations: [], date: '', needsCheck: false, ...over };
}
/** A judge that answers from a fixed table keyed by the two texts. */
function tableJudge(table: [string, string, JudgeVerdict][]): ClaimJudge & { calls: number } {
	const fn = (async (pairs) => {
		fn.calls += 1;
		const out = new Map<string, JudgeVerdict>();
		for (const pair of pairs) {
			const hit = table.find(([a, b]) => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
			out.set(pair.id, hit ? hit[2] : 'different');
		}
		return out;
	}) as ClaimJudge & { calls: number };
	fn.calls = 0;
	return fn;
}

describe('claim similarity', () => {
	it('scores paraphrases above unrelated claims', () => {
		const a = embedClaim('Election day is Monday, October 26, with polls open 10 a.m. to 8 p.m.');
		const b = embedClaim('Election day is Monday, Oct. 26, with polls open 10 a.m. to 8 p.m.');
		const c = embedClaim('Leonard sat out the pre-season opener against Miami');
		expect(cosine(a, b)).toBeGreaterThan(0.86);
		expect(cosine(a, c)).toBeLessThan(0.3);
	});

	it('normalizes punctuation, case and thousands separators', () => {
		expect(normalizeClaimText('About 330,000 students — daily.')).toBe(normalizeClaimText('about 330000 students daily'));
	});
});

describe('matchIncoming', () => {
	const cost = 'Chow did not say what the expansion would cost taxpayers';
	const figure = 'Chow has not put a dollar figure on the expansion and did not say what it would cost taxpayers';

	it('merges a paraphrase the judge calls the same fact', async () => {
		const judge = tableJudge([[cost, figure, 'same']]);
		const result = await matchIncoming([state('c1', cost)], [claim(figure)], judge);
		expect(result.matches).toEqual([{ kind: 'same', claimId: 'c1', how: 'judge' }]);
		expect(judge.calls).toBe(1);
	});

	it('links a conflicting figure instead of merging it', async () => {
		const city = 'The City of Toronto says 222,550 voters cast advance ballots over six days';
		const cp24 = 'CP24 reports 225,550 advance voters over six days';
		const result = await matchIncoming([state('c1', city)], [claim(cp24)], tableJudge([[city, cp24, 'contradicts']]));
		expect(result.matches).toEqual([{ kind: 'contradicts', claimId: 'c1' }]);
	});

	it('uses the explicit id and exact wording before asking the judge', async () => {
		const judge = tableJudge([]);
		const result = await matchIncoming(
			[state('c1', cost), state('c2', 'Bradford pledged a property tax freeze')],
			[claim('anything new', { supersedes: 'c2' }), claim('CHOW did not say what the expansion would cost taxpayers.')],
			judge
		);
		expect(result.matches).toEqual([
			{ kind: 'same', claimId: 'c2', how: 'id' },
			{ kind: 'same', claimId: 'c1', how: 'text' }
		]);
		expect(judge.calls).toBe(0);
	});

	it('without a judge merges only near-identical wordings with the same figures', async () => {
		const active = [
			state('c1', 'Election day is Monday, October 26, with polls open 10 a.m. to 8 p.m.'),
			state('c2', 'Police say two people were hurt in the Bloor Street crash')
		];
		const result = await matchIncoming(
			active,
			[
				claim('Election day is Monday, Oct. 26, with polls open 10 a.m. to 8 p.m.'),
				claim('Police say three people were hurt in the Bloor Street crash'),
				claim(figure)
			],
			async () => null
		);
		expect(result.judgeAvailable).toBe(false);
		expect(result.matches[0]).toEqual({ kind: 'same', claimId: 'c1', how: 'similar' });
		expect(result.matches[1]).toEqual({ kind: 'new' });
		expect(result.matches[2]).toEqual({ kind: 'new' });
	});

	it('matches a duplicate within the same block', async () => {
		const result = await matchIncoming([], [claim(cost), claim(figure)], tableJudge([[cost, figure, 'same']]));
		expect(result.matches).toEqual([{ kind: 'new' }, { kind: 'same', claimId: 'incoming:0', how: 'judge' }]);
	});

	it('survives a judge that throws', async () => {
		const result = await matchIncoming([state('c1', cost)], [claim(figure)], async () => {
			throw new Error('down');
		});
		expect(result.matches).toEqual([{ kind: 'new' }]);
	});
});
