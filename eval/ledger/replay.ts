/**
 * Replays recorded ledger threads through the matcher and planner exactly as
 * the server does, with judge verdicts from a recorded cassette, and scores the
 * result against golden labels.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planTurn, type ClaimEvent, type ClaimMatch, type ClaimState } from '../../src/lib/utils/claim-events';
import { matchIncoming, type ClaimJudge, type JudgePair, type JudgeVerdict } from '../../src/lib/utils/claim-matcher';
import { normalizeClaimText } from '../../src/lib/utils/claim-similarity';
import { normalizeLedgerClaim, type LedgerClaim, type LedgerStatus } from '../../src/lib/utils/story-ledger';

export const EVAL_DIR = new URL('.', import.meta.url).pathname;

export interface FixtureSource {
	n: number;
	url: string;
	date?: string;
	title?: string;
}
export interface FixtureThread {
	id: string;
	title: string;
	origin: 'prod' | 'generated' | 'redteam';
	sources: FixtureSource[];
	turns: { at: number; claims: unknown[] }[];
}
export interface GoldenLabels {
	thread: string;
	/** 'suggested' until a person has gone through it; then their name. */
	labeled_by: string;
	facts: { id: string; text: string; status: LedgerStatus }[];
	/** One entry per extracted claim, by turn and position in that turn's block. */
	claims: { turn: number; index: number; fact: string | null; valid: boolean }[];
	/** Facts the answers stated that no ledger claim captured. */
	missed: { turn: number; text: string }[];
}

export function loadJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadThreads(dir: string): FixtureThread[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.sort()
		.map((name) => loadJson<FixtureThread>(join(dir, name)));
}

export function turnClaims(turn: FixtureThread['turns'][number]): LedgerClaim[] {
	return turn.claims.map(normalizeLedgerClaim).filter((claim): claim is LedgerClaim => claim !== null);
}

// ---- judge cassette -------------------------------------------------------

const hash = (text: string) => createHash('sha1').update(normalizeClaimText(text)).digest('hex').slice(0, 16);
export const pairKey = (a: string, b: string) => [hash(a), hash(b)].sort().join('|');

export class Cassette {
	verdicts: Record<string, JudgeVerdict>;
	missing: JudgePair[] = [];
	constructor(private path: string) {
		this.verdicts = existsSync(path) ? loadJson<Record<string, JudgeVerdict>>(path) : {};
	}
	/** Replays recorded verdicts; a pair never recorded gets no verdict (the matcher's no-judge rule). */
	judge: ClaimJudge = async (pairs) => {
		const out = new Map<string, JudgeVerdict>();
		for (const pair of pairs) {
			const verdict = this.verdicts[pairKey(pair.a, pair.b)];
			if (verdict) out.set(pair.id, verdict);
			else this.missing.push(pair);
		}
		return out;
	};
	/**
	 * Record mode: pairs missing from the cassette are sent to a live judge
	 * (the worker's /v1/ledger/judge) and stored, then replayed as usual.
	 */
	recording(url: string, token: string): ClaimJudge {
		return async (pairs) => {
			const unknown = pairs.filter((pair) => !this.verdicts[pairKey(pair.a, pair.b)]);
			for (let i = 0; i < unknown.length; i += 30) {
				const batch = unknown.slice(i, i + 30);
				const response = await fetch(`${url.replace(/\/$/, '')}/v1/ledger/judge`, {
					method: 'POST',
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					body: JSON.stringify({ pairs: batch })
				});
				if (!response.ok) throw new Error(`judge returned ${response.status}`);
				const body = (await response.json()) as { verdicts: { id: string; verdict: JudgeVerdict }[] };
				for (const { id, verdict } of body.verdicts) {
					const pair = batch.find((p) => p.id === id);
					if (pair) this.verdicts[pairKey(pair.a, pair.b)] = verdict;
				}
			}
			return this.judge(pairs);
		};
	}
	save() {
		const sorted = Object.fromEntries(Object.entries(this.verdicts).sort(([a], [b]) => a.localeCompare(b)));
		writeFileSync(this.path, JSON.stringify(sorted, null, 1) + '\n');
	}
}

// ---- replay ---------------------------------------------------------------

export type Matcher = 'events' | 'exact';

export interface Replay {
	live: ClaimState[];
	events: ClaimEvent[];
	/** Live claim id for each extracted claim, keyed `${turn}:${index}`. */
	landedOn: Map<string, string>;
}

/** `exact` reproduces the pre-rework upsert (case-insensitive exact text only). */
export async function replayThread(thread: FixtureThread, judge: ClaimJudge | null, matcher: Matcher = 'events'): Promise<Replay> {
	const states = new Map<string, ClaimState>();
	const events: ClaimEvent[] = [];
	const landedOn = new Map<string, string>();
	let n = 0;
	for (const [t, turn] of thread.turns.entries()) {
		const incoming = turnClaims(turn);
		const active = [...states.values()];
		let matches: ClaimMatch[];
		if (matcher === 'exact') {
			const seen = new Map(active.map((s) => [s.claim.replace(/\s+/g, ' ').trim().toLowerCase(), s.id]));
			matches = incoming.map((c, i) => {
				const key = c.claim.replace(/\s+/g, ' ').trim().toLowerCase();
				const hit = seen.get(key) ?? incoming.slice(0, i).findIndex((x) => x.claim.replace(/\s+/g, ' ').trim().toLowerCase() === key);
				if (typeof hit === 'string') return { kind: 'same', claimId: hit, how: 'text' };
				return hit >= 0 ? { kind: 'same', claimId: `incoming:${hit}`, how: 'text' } : { kind: 'new' };
			});
		} else {
			matches = (await matchIncoming(active, incoming, judge)).matches;
		}
		const plan = planTurn({ active, incoming, matches, messageId: `${thread.id}:${t}`, at: turn.at, newId: () => `${thread.id}#${++n}` });
		for (const c of [...plan.created, ...plan.touched.values()]) states.set(c.id, c);
		events.push(...plan.events);
		plan.resolved.forEach((id, i) => id && landedOn.set(`${t}:${i}`, id));
	}
	return { live: [...states.values()].filter((s) => s.status !== undefined), events, landedOn };
}

// ---- metrics --------------------------------------------------------------

export interface ThreadScore {
	thread: string;
	labeledBy: string;
	extracted: number;
	valid: number;
	facts: number;
	missed: number;
	live: number;
	duplicates: number;
	wrongMerges: number;
	statusChecked: number;
	statusCorrect: number;
}

export function scoreThread(replay: Replay, labels: GoldenLabels): ThreadScore {
	const factsByLive = new Map<string, Set<string>>();
	let extracted = 0;
	let valid = 0;
	for (const label of labels.claims) {
		extracted += 1;
		if (label.valid) valid += 1;
		const live = replay.landedOn.get(`${label.turn}:${label.index}`);
		if (!live || !label.valid || !label.fact) continue;
		factsByLive.set(live, (factsByLive.get(live) ?? new Set()).add(label.fact));
	}
	const liveIds = replay.live.map((s) => s.id);
	const liveByFact = new Map<string, number>();
	let wrongMerges = 0;
	for (const id of liveIds) {
		const facts = factsByLive.get(id);
		if (!facts) continue;
		if (facts.size > 1) wrongMerges += 1;
		for (const fact of facts) liveByFact.set(fact, (liveByFact.get(fact) ?? 0) + 1);
	}
	const duplicates = [...liveByFact.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
	const goldStatus = new Map(labels.facts.map((f) => [f.id, f.status]));
	let statusChecked = 0;
	let statusCorrect = 0;
	for (const state of replay.live) {
		const facts = factsByLive.get(state.id);
		if (!facts || facts.size !== 1) continue;
		const gold = goldStatus.get([...facts][0]);
		if (!gold) continue;
		statusChecked += 1;
		if (gold === state.status) statusCorrect += 1;
	}
	return {
		thread: labels.thread,
		labeledBy: labels.labeled_by,
		extracted,
		valid,
		facts: new Set(labels.claims.filter((c) => c.valid && c.fact).map((c) => c.fact)).size,
		missed: labels.missed.length,
		live: liveIds.length,
		duplicates,
		wrongMerges,
		statusChecked,
		statusCorrect
	};
}

export function summarize(scores: ThreadScore[]) {
	const sum = (key: keyof ThreadScore) => scores.reduce((total, s) => total + (s[key] as number), 0);
	const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 10000) / 10000 : null);
	return {
		threads: scores.length,
		extractionPrecision: ratio(sum('valid'), sum('extracted')),
		extractionRecall: ratio(sum('facts'), sum('facts') + sum('missed')),
		liveClaims: sum('live'),
		duplicateRate: ratio(sum('duplicates'), sum('live')),
		wrongMerges: sum('wrongMerges'),
		statusAccuracy: ratio(sum('statusCorrect'), sum('statusChecked'))
	};
}
