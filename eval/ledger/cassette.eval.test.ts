import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyRequest, type CopyFormat, type CopyLine, type CopyRequestClaim } from '../../src/lib/utils/ledger-copy';
import type { JudgeVerdict } from '../../src/lib/utils/claim-matcher';
import { LEDGER_MAX_CLAIMS, normalizeLedgerClaim } from '../../src/lib/utils/story-ledger';
import { Cassette, EVAL_DIR, loadJson, pairKey, replayThread, type FixtureThread, type GoldenLabels } from './replay';

interface OfflineUpdates {
	judge: { key: string; verdict: JudgeVerdict; thread: string; claims: { turn: number; index: number; fact: string }[] }[];
	copy: { thread: string; turns: number; format: CopyFormat; from: string; to: string; removed: CopyRequestClaim[] }[];
}

const updates = loadJson<OfflineUpdates>(join(EVAL_DIR, 'offline-cassette-updates.json'));
const copies = loadJson<Record<string, CopyLine[]>>(join(EVAL_DIR, 'copy-cassette.json'));
const judges = loadJson<Record<string, JudgeVerdict>>(join(EVAL_DIR, 'judge-cassette.json'));
const requestKey = (format: CopyFormat, title: string, claims: CopyRequestClaim[]) =>
	createHash('sha1').update(JSON.stringify([format, title, claims])).digest('hex').slice(0, 20);

describe('offline cassette provenance', () => {
	for (const update of updates.judge) {
		it(`derives ${update.key} from distinct reviewed golden facts`, () => {
			const thread = loadJson<FixtureThread>(join(EVAL_DIR, 'fixtures', `${update.thread}.json`));
			const labels = loadJson<GoldenLabels>(join(EVAL_DIR, 'golden', `${update.thread}.json`));
			expect(labels.labeled_by).not.toBe('suggested');
			const texts = update.claims.map((position) => {
				const label = labels.claims.find((claim) => claim.turn === position.turn && claim.index === position.index);
				expect(label).toMatchObject({ valid: true, fact: position.fact });
				expect(labels.facts.some((fact) => fact.id === position.fact)).toBe(true);
				return normalizeLedgerClaim(thread.turns[position.turn].claims[position.index])!.claim;
			});
			expect(texts).toHaveLength(2);
			expect(new Set(update.claims.map((claim) => claim.fact)).size).toBe(2);
			expect(pairKey(texts[0], texts[1])).toBe(update.key);
			expect(update.verdict).toBe('different');
			expect(judges[update.key]).toBe(update.verdict);
		});
	}

	for (const update of updates.copy) {
		it(`preserves every recorded line when projecting ${update.thread}@${update.turns} ${update.format}`, async () => {
			const thread = loadJson<FixtureThread>(join(EVAL_DIR, 'fixtures', `${update.thread}.json`));
			const cassette = new Cassette(join(EVAL_DIR, 'judge-cassette.json'));
			const replay = await replayThread({ ...thread, turns: thread.turns.slice(0, update.turns) }, cassette.judge, 'events', { evidence: true });
			const { request } = copyRequest(replay.live.map((state) => ({
				id: state.id,
				claim: state.claim,
				status: state.status,
				attributed_to: state.attributedTo,
				needs_check: state.needsCheck,
				sources: state.evidence.map((source) => ({ url: source.url, host: source.host, tier: source.tier }))
			})));
			expect(cassette.missing).toHaveLength(0);
			expect(requestKey(update.format, thread.title, request)).toBe(update.to);
			expect(requestKey(update.format, thread.title, [...request, ...update.removed])).toBe(update.from);
			const original = copies[update.from];
			expect(original.length).toBeGreaterThan(0);
			expect(copies[update.to]).toEqual(original);
			const references = new Set(request.map((claim) => claim.id));
			for (const line of original) {
				for (const reference of line.claims) expect(references.has(reference), reference).toBe(true);
			}
			const capped = thread.turns[update.turns - 1].claims.map(normalizeLedgerClaim).filter((claim) => claim !== null).slice(LEDGER_MAX_CLAIMS);
			for (const removed of update.removed) {
				expect(references.has(removed.id)).toBe(false);
				expect(capped.some((claim) => claim.claim === removed.claim)).toBe(true);
			}
		});
	}
});
