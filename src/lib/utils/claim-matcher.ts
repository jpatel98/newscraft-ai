/**
 * Decide, for each claim in a new ledger block, whether it restates a claim the
 * chat already has, conflicts with one, or is new. Candidates come from the
 * hashed claim embedding; a judge call (the worker's model) settles each
 * candidate pair. Without a judge, only near-identical wordings with the same
 * figures merge, so a judge outage can add duplicates but never wrong merges.
 */
import type { ClaimMatch, ClaimState } from './claim-events';
import { incomingRef } from './claim-events';
import { claimNumbers, cosine, embedClaim, normalizeClaimText, type ClaimVector } from './claim-similarity';
import type { LedgerClaim } from './story-ledger';

export type JudgeVerdict = 'same' | 'contradicts' | 'different';
export interface JudgePair {
	id: string;
	a: string;
	b: string;
}
/** Returns a verdict per pair id, or null when the judge could not be reached. */
export type ClaimJudge = (pairs: JudgePair[]) => Promise<Map<string, JudgeVerdict> | null>;

export const MATCH_CANDIDATES = 3;
export const MATCH_MIN_SCORE = 0.2;
/** Without a judge verdict, merge only above this score and with identical figures. */
export const MATCH_AUTO_SCORE = 0.86;

interface PoolEntry {
	ref: string;
	text: string;
	keys: Set<string>;
	vectors: ClaimVector[];
}

function sameNumbers(a: string, b: string): boolean {
	const x = claimNumbers(a);
	const y = claimNumbers(b);
	return x.length === y.length && x.every((n) => y.includes(n));
}

function bestScore(query: ClaimVector, entry: PoolEntry): number {
	return Math.max(...entry.vectors.map((vector) => cosine(query, vector)));
}

export interface MatchResult {
	matches: ClaimMatch[];
	/** Pairs sent to the judge and what came back (for diagnostics and evals). */
	judged: { pair: JudgePair; verdict: JudgeVerdict | null; score: number }[];
	judgeAvailable: boolean;
}

export async function matchIncoming(
	active: readonly ClaimState[],
	incoming: readonly LedgerClaim[],
	judge: ClaimJudge | null
): Promise<MatchResult> {
	const pool: PoolEntry[] = active.map((claim) => {
		const texts = [claim.claim, ...claim.variants];
		return {
			ref: claim.id,
			text: claim.claim,
			keys: new Set(texts.map(normalizeClaimText)),
			vectors: texts.map(embedClaim)
		};
	});
	const activeIds = new Set(active.map((claim) => claim.id));
	const queries = incoming.map((claim) => embedClaim(claim.claim));

	// First pass: explicit ids and exact wordings, and the candidate pairs for the rest.
	const early: (ClaimMatch | null)[] = [];
	const candidates: { index: number; entry: PoolEntry; score: number; pairId: string }[][] = [];
	const pairs: JudgePair[] = [];
	incoming.forEach((claim, index) => {
		const key = normalizeClaimText(claim.claim);
		const visible = pool.slice(0, active.length + index);
		let match: ClaimMatch | null = null;
		if (claim.supersedes && activeIds.has(claim.supersedes)) match = { kind: 'same', claimId: claim.supersedes, how: 'id' };
		if (!match) {
			const exact = visible.find((entry) => entry.keys.has(key));
			if (exact) match = { kind: 'same', claimId: exact.ref, how: 'text' };
		}
		early.push(match);
		const found = match
			? []
			: visible
					.map((entry) => ({ entry, score: bestScore(queries[index], entry) }))
					.filter(({ score }) => score >= MATCH_MIN_SCORE)
					.sort((a, b) => b.score - a.score)
					.slice(0, MATCH_CANDIDATES)
					.map(({ entry, score }) => {
						const pairId = `${index}:${entry.ref}`;
						pairs.push({ id: pairId, a: entry.text, b: claim.claim });
						return { index, entry, score, pairId };
					});
		candidates.push(found);
		pool.push({ ref: incomingRef(index), text: claim.claim, keys: new Set([key]), vectors: [queries[index]] });
	});

	let verdicts: Map<string, JudgeVerdict> | null = null;
	if (pairs.length && judge) {
		try {
			verdicts = await judge(pairs);
		} catch {
			verdicts = null;
		}
	}

	const judged: MatchResult['judged'] = [];
	const matches: ClaimMatch[] = incoming.map((claim, index) => {
		if (early[index]) return early[index]!;
		let conflict: string | null = null;
		for (const candidate of candidates[index]) {
			const verdict = verdicts?.get(candidate.pairId) ?? null;
			judged.push({ pair: pairs.find((pair) => pair.id === candidate.pairId)!, verdict, score: candidate.score });
			if (verdict === 'same') return { kind: 'same', claimId: candidate.entry.ref, how: 'judge' };
			if (verdict === 'contradicts' && !conflict) conflict = candidate.entry.ref;
			if (verdict === null && candidate.score >= MATCH_AUTO_SCORE && sameNumbers(candidate.entry.text, claim.claim)) {
				return { kind: 'same', claimId: candidate.entry.ref, how: 'similar' };
			}
		}
		return conflict ? { kind: 'contradicts', claimId: conflict } : { kind: 'new' };
	});
	return { matches, judged, judgeAvailable: verdicts !== null };
}
