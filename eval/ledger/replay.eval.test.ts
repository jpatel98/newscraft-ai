import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { LEDGER_FENCE_OPEN, LEDGER_MAX_CLAIMS, normalizeLedgerClaim, splitLedgerBlock } from '../../src/lib/utils/story-ledger';
import { EVAL_DIR, loadJson, loadThreads, replayThread, turnClaims, type FixtureThread, type GoldenLabels } from './replay';

const claim = (index: number) => ({ claim: `Independent fact number ${index}`, status: 'reported', citations: [], needs_check: false });

describe('production-equivalent fixture extraction', () => {
	it('covers every production claim with its raw golden position and excludes rejected claims', async () => {
		const threads = loadThreads(join(EVAL_DIR, 'fixtures'));
		expect(threads).toHaveLength(21);
		for (const thread of threads) {
			const labels = loadJson<GoldenLabels>(join(EVAL_DIR, 'golden', `${thread.id}.json`));
			const replay = await replayThread(thread, null, 'exact');
			for (const [turnIndex, turn] of thread.turns.entries()) {
				const indices = turn.claims.flatMap((raw, index) => normalizeLedgerClaim(raw) ? [index] : []).slice(0, LEDGER_MAX_CLAIMS);
				const positions = labels.claims.filter((label) => label.turn === turnIndex).map((label) => label.index);
				const rejected = turn.claims.flatMap((raw, index) => normalizeLedgerClaim(raw) ? [] : [index]);
				expect(positions, `${thread.id}@${turnIndex}`).toEqual([...indices, ...rejected].sort((left, right) => left - right));
				expect(turnClaims(turn)).toHaveLength(indices.length);
				for (const index of indices) expect(replay.landedOn.has(`${turnIndex}:${index}`)).toBe(true);
				for (const index of rejected) expect(replay.landedOn.has(`${turnIndex}:${index}`)).toBe(false);
			}
		}
	});

	it('uses the production extractor and caps a turn containing more than twelve claims', async () => {
		const turn = { at: 1, claims: Array.from({ length: LEDGER_MAX_CLAIMS + 3 }, (_, index) => claim(index)) };
		const production = splitLedgerBlock(`${LEDGER_FENCE_OPEN}\n${JSON.stringify({ claims: turn.claims })}\n\`\`\``).claims;
		expect(turnClaims(turn)).toEqual(production);
		expect(turnClaims(turn)).toHaveLength(LEDGER_MAX_CLAIMS);
		const thread: FixtureThread = { id: 'synthetic', title: 'Synthetic', origin: 'generated', turns: [turn] };
		const replay = await replayThread(thread, null, 'exact');
		expect(replay.live).toHaveLength(LEDGER_MAX_CLAIMS);
		expect(replay.landedOn.size).toBe(LEDGER_MAX_CLAIMS);
		expect(replay.landedOn.has(`0:${LEDGER_MAX_CLAIMS}`)).toBe(false);
		expect(replay.events.some((event) => event.data.text === turn.claims[LEDGER_MAX_CLAIMS].claim)).toBe(false);
	});

	it('counts valid claims toward the cap and preserves raw positions for golden labels', async () => {
		const claims = [null, claim(0), { claim: 'Invalid status', status: 'invalid' }, ...Array.from({ length: LEDGER_MAX_CLAIMS + 1 }, (_, index) => claim(index + 1))];
		const thread: FixtureThread = { id: 'synthetic', title: 'Synthetic', origin: 'generated', turns: [{ at: 1, claims }] };
		const replay = await replayThread(thread, null, 'exact');
		expect(replay.live).toHaveLength(LEDGER_MAX_CLAIMS);
		expect(replay.landedOn.has('0:0')).toBe(false);
		expect(replay.landedOn.get('0:1')).toBe('synthetic#1');
		expect(replay.landedOn.has('0:2')).toBe(false);
		expect(replay.landedOn.get('0:3')).toBe('synthetic#2');
		expect(replay.landedOn.get(`0:${LEDGER_MAX_CLAIMS + 1}`)).toBe(`synthetic#${LEDGER_MAX_CLAIMS}`);
		expect(replay.landedOn.has(`0:${LEDGER_MAX_CLAIMS + 2}`)).toBe(false);
	});
});
