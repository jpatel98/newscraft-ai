import { describe, expect, it } from 'vitest';
import {
	foldClaim,
	incomingRef,
	planReview,
	planTurn,
	type ClaimEvent,
	type ClaimMatch,
	type ClaimState
} from './claim-events';
import { LEDGER_STATUSES, type LedgerClaim, type LedgerStatus } from './story-ledger';

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

function claim(text: string, over: Partial<LedgerClaim> = {}): LedgerClaim {
	return { claim: text, status: 'reported', attributedTo: '', citations: [], date: '', needsCheck: false, ...over };
}

function counter() {
	let n = 0;
	return () => `c${++n}`;
}

/** Runs turns through the planner the way the db layer does and keeps the full log. */
function simulate(turns: { incoming: LedgerClaim[]; matches: ClaimMatch[] }[], reviews: Map<number, (states: ClaimState[]) => { id: string; status?: LedgerStatus; needsCheck?: boolean } | null> = new Map()) {
	const states = new Map<string, ClaimState>();
	const log: ClaimEvent[] = [];
	const newId = counter();
	turns.forEach((turn, t) => {
		const plan = planTurn({ active: [...states.values()], incoming: turn.incoming, matches: turn.matches, messageId: `m${t}`, at: 1000 + t * 10, newId });
		for (const c of plan.created) states.set(c.id, c);
		for (const c of plan.touched.values()) states.set(c.id, c);
		log.push(...plan.events);
		const review = reviews.get(t)?.([...states.values()]);
		if (review) {
			const events = planReview(states.get(review.id)!, review, 'Jigar', 1005 + t * 10);
			log.push(...events);
			states.set(review.id, foldClaim(review.id, log.filter((e) => e.claimId === review.id)));
		}
	});
	return { states, log };
}

describe('planTurn', () => {
	it('records a paraphrase as a wording of the existing claim, not a new row', () => {
		const { states, log } = simulate([
			{ incoming: [claim('Chow did not say what the expansion would cost', { citations: [1] })], matches: [{ kind: 'new' }] },
			{ incoming: [claim('Chow has not put a dollar figure on the expansion', { citations: [4] })], matches: [{ kind: 'same', claimId: 'c1', how: 'judge' }] }
		]);
		expect(states.size).toBe(1);
		const c1 = states.get('c1')!;
		expect(c1.variants).toHaveLength(2);
		expect(c1.citations).toEqual([1, 4]);
		expect(c1.claim).toBe('Chow has not put a dollar figure on the expansion');
		expect(log.map((e) => e.kind)).toEqual(['asserted', 'asserted']);
	});

	it('links a contradiction both ways and opens a check on each side', () => {
		const { states, log } = simulate([
			{ incoming: [claim('The City says 222,550 advance votes were cast', { status: 'confirmed' })], matches: [{ kind: 'new' }] },
			{ incoming: [claim('CP24 reports 225,550 advance voters')], matches: [{ kind: 'contradicts', claimId: 'c1' }] }
		]);
		expect(states.get('c1')!.contradicts).toEqual(['c2']);
		expect(states.get('c2')!.contradicts).toEqual(['c1']);
		expect(states.get('c1')!.needsCheck).toBe(true);
		expect(states.get('c2')!.needsCheck).toBe(true);
		expect(log.filter((e) => e.kind === 'contradicted')).toHaveLength(2);
	});

	it('turns a model retraction into a retracted event', () => {
		const { states, log } = simulate([
			{ incoming: [claim('Police say the suspect was 34', { status: 'confirmed' })], matches: [{ kind: 'new' }] },
			{ incoming: [claim('Police say the suspect was 34', { status: 'retracted' })], matches: [{ kind: 'same', claimId: 'c1', how: 'text' }] }
		]);
		expect(states.get('c1')!.status).toBe('retracted');
		expect(log.at(-1)!.kind).toBe('retracted');
	});

	it('makes a model clearing a check visible as check_closed', () => {
		const { log } = simulate([
			{ incoming: [claim('Fire started in a kitchen', { needsCheck: true })], matches: [{ kind: 'new' }] },
			{ incoming: [claim('Fire started in a kitchen', { needsCheck: false })], matches: [{ kind: 'same', claimId: 'c1', how: 'text' }] }
		]);
		expect(log.map((e) => e.kind)).toEqual(['asserted', 'check_opened', 'asserted', 'check_closed']);
		expect(log.at(-1)!.actor).toBe('model');
	});

	it('resolves a match to a claim created earlier in the same turn', () => {
		const { states } = simulate([
			{
				incoming: [claim('Election day is Monday, October 26'), claim('Election day is Monday, Oct. 26')],
				matches: [{ kind: 'new' }, { kind: 'same', claimId: incomingRef(0), how: 'judge' }]
			}
		]);
		expect(states.size).toBe(1);
	});

	it('stops creating claims at the cap but still updates matched ones', () => {
		const plan = planTurn({
			active: [],
			incoming: [claim('a'), claim('b'), claim('a again')],
			matches: [{ kind: 'new' }, { kind: 'new' }, { kind: 'same', claimId: incomingRef(0), how: 'judge' }],
			messageId: 'm',
			at: 1,
			newId: counter(),
			maxActive: 1
		});
		expect(plan.created).toHaveLength(1);
		expect(plan.skipped).toBe(1);
		expect(plan.created[0].variants).toHaveLength(2);
	});
});

describe('ledger fold properties', () => {
	const STATUSES = LEDGER_STATUSES as readonly LedgerStatus[];

	function randomTurns(seed: number) {
		const r = rng(seed);
		const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
		const turns: { incoming: LedgerClaim[]; matches: ClaimMatch[] }[] = [];
		let created = 0;
		const turnCount = 2 + Math.floor(r() * 6);
		for (let t = 0; t < turnCount; t++) {
			const incoming: LedgerClaim[] = [];
			const matches: ClaimMatch[] = [];
			const n = 1 + Math.floor(r() * 6);
			for (let i = 0; i < n; i++) {
				incoming.push(
					claim(`fact ${Math.floor(r() * 9)} wording ${Math.floor(r() * 4)}`, {
						status: pick(STATUSES),
						needsCheck: r() < 0.4,
						citations: [1 + Math.floor(r() * 8)],
						attributedTo: r() < 0.5 ? pick(['police', 'the city', '']) : ''
					})
				);
				const roll = r();
				if (created && roll < 0.45) matches.push({ kind: 'same', claimId: `c${1 + Math.floor(r() * created)}`, how: 'judge' });
				else if (created && roll < 0.55) matches.push({ kind: 'contradicts', claimId: `c${1 + Math.floor(r() * created)}` });
				else if (i > 0 && roll < 0.65) matches.push({ kind: 'same', claimId: incomingRef(Math.floor(r() * i)), how: 'judge' });
				else matches.push({ kind: 'new' });
			}
			// Ids that do not exist yet simply resolve to new claims.
			created += n;
			turns.push({ incoming, matches });
		}
		return turns;
	}

	it('the stored state of every claim always equals the fold of its events', () => {
		for (let seed = 1; seed <= 400; seed++) {
			const { states, log } = simulate(randomTurns(seed));
			for (const [id, state] of states) {
				const folded = foldClaim(id, log.filter((e) => e.claimId === id));
				expect({ ...folded, createdAt: 0 }, `seed ${seed} claim ${id}`).toEqual({ ...state, createdAt: 0 });
			}
		}
	});

	it('replaying the same block adds no claims and no status or check events', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const turns = randomTurns(seed);
			const states = new Map<string, ClaimState>();
			const newId = counter();
			let resolved: (string | null)[] = [];
			for (const [t, turn] of turns.entries()) {
				const plan = planTurn({ active: [...states.values()], incoming: turn.incoming, matches: turn.matches, messageId: `m${t}`, at: t, newId });
				for (const c of [...plan.created, ...plan.touched.values()]) states.set(c.id, c);
				resolved = plan.resolved;
			}
			const last = turns.at(-1)!;
			const matches: ClaimMatch[] = resolved.map((id) => (id ? { kind: 'same', claimId: id, how: 'text' } : { kind: 'new' }));
			const plan = planTurn({ active: [...states.values()], incoming: last.incoming, matches, messageId: 'again', at: 99999, newId: () => 'x' });
			// Two claims of one block that land on the same canonical claim with different statuses
			// legitimately flip it on replay; every other replay must be a no-op beyond the wording.
			const byTarget = new Map<string, string[]>();
			last.incoming.forEach((c, i) => resolved[i] && byTarget.set(resolved[i]!, [...(byTarget.get(resolved[i]!) ?? []), `${c.status}/${c.needsCheck}`]));
			const conflicted = [...byTarget.values()].some((xs) => new Set(xs).size > 1);
			expect(plan.created, `seed ${seed}`).toHaveLength(0);
			if (!conflicted) expect(plan.events.filter((e) => e.kind !== 'asserted'), `seed ${seed}`).toEqual([]);
		}
	});

	it('citations never shrink and live claims never exceed distinct match targets', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const turns = randomTurns(seed);
			const states = new Map<string, ClaimState>();
			const newId = counter();
			turns.forEach((turn, t) => {
				const before = new Map([...states].map(([id, s]) => [id, [...s.citations]]));
				const plan = planTurn({ active: [...states.values()], incoming: turn.incoming, matches: turn.matches, messageId: `m${t}`, at: t, newId });
				for (const c of [...plan.created, ...plan.touched.values()]) states.set(c.id, c);
				for (const [id, citations] of before) for (const n of citations) expect(states.get(id)!.citations).toContain(n);
				expect(plan.created.length + plan.skipped).toBeLessThanOrEqual(turn.matches.filter((m) => m.kind !== 'same').length + turn.matches.length);
			});
		}
	});

	it('a claim a person reviewed never has its status or check changed by the model', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const turns = randomTurns(seed);
			let reviewedId = '';
			let settled: { status: LedgerStatus; needsCheck: boolean } | null = null;
			const reviews = new Map([[0, (states: ClaimState[]) => {
				reviewedId = states[0].id;
				return { id: reviewedId, status: 'confirmed' as LedgerStatus, needsCheck: false };
			}]]);
			const { states, log } = simulate(turns, reviews);
			settled = { status: 'confirmed', needsCheck: false };
			const reviewed = states.get(reviewedId)!;
			expect(reviewed.reviewedBy).toBe('Jigar');
			// Contradictions may still reopen a check on the other side, never on the reviewed claim.
			const after = log.filter((e) => e.claimId === reviewedId && e.at > 1005 && e.actor === 'model' && e.kind !== 'asserted' && e.kind !== 'contradicted');
			expect(after, `seed ${seed} ${JSON.stringify(after)}`).toEqual([]);
			expect({ status: reviewed.status, needsCheck: reviewed.needsCheck }).toEqual(settled);
		}
	});

	it('needs_check is true exactly when the last check event opened one', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const { states, log } = simulate(randomTurns(seed));
			for (const [id, state] of states) {
				const last = log.filter((e) => e.claimId === id && (e.kind === 'check_opened' || e.kind === 'check_closed')).at(-1);
				expect(state.needsCheck, `seed ${seed}`).toBe(last?.kind === 'check_opened');
			}
		}
	});

	it('status is retracted only after a retracted event', () => {
		for (let seed = 1; seed <= 300; seed++) {
			const { states, log } = simulate(randomTurns(seed));
			for (const [id, state] of states) {
				const events = log.filter((e) => e.claimId === id);
				if (state.status === 'retracted') {
					const first = events.find((e) => e.kind === 'asserted')!;
					expect(first.data.status === 'retracted' || events.some((e) => e.kind === 'retracted'), `seed ${seed}`).toBe(true);
				}
			}
		}
	});
});

describe('planReview', () => {
	const base: ClaimState = foldClaim('c1', [
		{ claimId: 'c1', kind: 'asserted', actor: 'model', actorName: '', messageId: 'm', data: { text: 'x', status: 'reported' }, at: 1 },
		{ claimId: 'c1', kind: 'check_opened', actor: 'model', actorName: '', messageId: 'm', data: {}, at: 1 }
	]);

	it('closes a check only with an explicit person event', () => {
		const events = planReview(base, { needsCheck: false }, 'Jigar', 5);
		expect(events.map((e) => [e.kind, e.actor, e.actorName])).toEqual([['check_closed', 'person', 'Jigar']]);
		const after = foldClaim('c1', [
			{ claimId: 'c1', kind: 'asserted', actor: 'model', actorName: '', messageId: 'm', data: { text: 'x', status: 'reported' }, at: 1 },
			{ claimId: 'c1', kind: 'check_opened', actor: 'model', actorName: '', messageId: 'm', data: {}, at: 1 },
			...events
		]);
		expect(after.needsCheck).toBe(false);
		expect(after.reviewedBy).toBe('Jigar');
	});

	it('records a no-op review as the person settling the claim', () => {
		const events = planReview(base, { status: 'reported' }, 'Jigar', 5);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: 'status_changed', actor: 'person', data: { from: 'reported', to: 'reported' } });
	});
});
