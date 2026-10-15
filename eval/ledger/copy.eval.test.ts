/**
 * Phase 4: broadcast copy written from the ledger keeps every attribution.
 *
 * 100 scripts: ledger states from the recorded threads (after each turn,
 * evidence on) times the three formats, written by the worker's copy model and
 * replayed from a cassette. Every sentence that states a reported or alleged
 * claim must carry one of that claim's allowed wordings after the app's check.
 * The raw model output is reported too, so a prompt regression shows up even
 * though the check repairs it.
 *
 * Record: LEDGER_EVAL_COPY_URL=<worker> LEDGER_EVAL_COPY_TOKEN=<token> pnpm eval:ledger
 */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaimState } from '../../src/lib/utils/claim-events';
import {
	checkCopy,
	COPY_FORMATS,
	copyRequest,
	lostAttributions,
	type CopyClaim,
	type CopyFormat,
	type CopyLine,
	type CopyRequestClaim
} from '../../src/lib/utils/ledger-copy';
import { Cassette, EVAL_DIR, loadJson, loadThreads, replayThread } from './replay';

const SCRIPTS = 100;
const CASSETTE = join(EVAL_DIR, 'copy-cassette.json');

function toCopyClaim(state: ClaimState): CopyClaim {
	return {
		id: state.id,
		claim: state.claim,
		status: state.status,
		attributed_to: state.attributedTo,
		needs_check: state.needsCheck,
		sources: state.evidence.map((s) => ({ url: s.url, host: s.host, tier: s.tier }))
	};
}

const requestKey = (format: CopyFormat, title: string, claims: CopyRequestClaim[]) =>
	createHash('sha1').update(JSON.stringify([format, title, claims])).digest('hex').slice(0, 20);

describe('copy from the ledger', () => {
	it(`loses no attribution across ${SCRIPTS} scripts`, async () => {
		const recorded: Record<string, CopyLine[]> = existsSync(CASSETTE) ? loadJson(CASSETTE) : {};
		const recordUrl = process.env.LEDGER_EVAL_COPY_URL;
		const judge = new Cassette(join(EVAL_DIR, 'judge-cassette.json')).judge;

		// Ledger states after each turn, latest turns first, then formats, until there are enough scripts.
		const jobs: { id: string; title: string; format: CopyFormat; claims: CopyClaim[] }[] = [];
		const threads = loadThreads(join(EVAL_DIR, 'fixtures'));
		const states: { id: string; title: string; claims: CopyClaim[] }[] = [];
		for (const thread of threads) {
			for (let turns = thread.turns.length; turns >= 1; turns--) {
				const replay = await replayThread({ ...thread, turns: thread.turns.slice(0, turns) }, judge, 'events', { evidence: true });
				states.push({ id: `${thread.id}@${turns}`, title: thread.title ?? thread.id, claims: replay.live.map(toCopyClaim) });
			}
		}
		for (let round = 0; jobs.length < SCRIPTS && round < 3; round++) {
			for (const [i, state] of states.entries()) {
				if (jobs.length >= SCRIPTS) break;
				if (copyRequest(state.claims).request.length) jobs.push({ ...state, format: COPY_FORMATS[(i + round) % 3] });
			}
		}
		expect(jobs.length).toBe(SCRIPTS);

		const used = new Set<string>();
		let missing = 0;
		let rawLost = 0;
		let repaired = 0;
		let dropped = 0;
		let lostAfter = 0;
		let requiredClaimsUsed = 0;
		const examples: string[] = [];
		for (const job of jobs) {
			const { request, byRef, withheld } = copyRequest(job.claims);
			const key = requestKey(job.format, job.title, request);
			used.add(key);
			if (!recorded[key] && recordUrl) {
				const response = await fetch(`${recordUrl.replace(/\/$/, '')}/v1/ledger/copy`, {
					method: 'POST',
					headers: { authorization: `Bearer ${process.env.LEDGER_EVAL_COPY_TOKEN || ''}`, 'content-type': 'application/json' },
					body: JSON.stringify({ format: job.format, title: job.title, claims: request })
				});
				if (!response.ok) throw new Error(`copy returned ${response.status}`);
				recorded[key] = ((await response.json()) as { lines: CopyLine[] }).lines;
			}
			const lines = recorded[key];
			if (!lines) {
				missing += 1;
				continue;
			}
			const raw = lostAttributions(lines, byRef);
			rawLost += raw.length;
			const checked = checkCopy(lines, byRef, withheld);
			if (process.env.COPY_DEBUG) for (const r of raw) {
				const c = job.claims.find((x) => x.id === r.claimId)!;
				const line = lines[r.line];
				const fixed = checkCopy([line], byRef, withheld).lines[0]?.text;
				console.log(`\n${job.id} ${job.format} tags=${line.claims.join(',')} via=${[...byRef.entries()].find(([, v]) => v === c)?.[0]} ${c.status} [${c.attributed_to}]\n  CLAIM: ${c.claim}\n  RAW:   ${line.text}\n  FIXED: ${fixed}`);
			}
			if (raw.length && examples.length < 12) examples.push(`${job.id} ${job.format}: ${raw[0].text}`);
			repaired += checked.repaired;
			dropped += checked.dropped;
			lostAfter += lostAttributions(checked.lines, byRef).length;
			requiredClaimsUsed += new Set(
				checked.lines.flatMap((l) => l.claims).filter((ref) => byRef.get(ref) && byRef.get(ref)!.status !== 'confirmed')
			).size;
		}
		if (recordUrl) {
			const kept = Object.fromEntries(Object.entries(recorded).filter(([key]) => used.has(key)));
			writeFileSync(CASSETTE, JSON.stringify(kept, null, 1) + '\n');
		}
		const report = { scripts: jobs.length, unrecorded: missing, attributedClaimsUsed: requiredClaimsUsed, rawLost, repaired, dropped, lostAfterCheck: lostAfter, examples };
		writeFileSync(join(EVAL_DIR, 'copy-report.json'), JSON.stringify(report, null, 1) + '\n');
		console.log(JSON.stringify(report));
		expect(missing, 'record the copy cassette (LEDGER_EVAL_COPY_URL)').toBe(0);
		expect(lostAfter).toBe(0);
	}, 900_000);
});
