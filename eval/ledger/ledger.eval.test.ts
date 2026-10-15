import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attributionRequired } from '../../src/lib/utils/claim-evidence';
import type { JudgeVerdict } from '../../src/lib/utils/claim-matcher';
import {
	Cassette,
	EVAL_DIR,
	loadJson,
	loadThreads,
	pairKey,
	replayThread,
	scoreThread,
	summarize,
	type FixtureThread,
	type GoldenLabels
} from './replay';

/** Highest rework phase whose expectations must hold. */
const LEDGER_PHASE = 2;
const EVIDENCE = LEDGER_PHASE >= 2;
const TARGET_DUPLICATE_RATE = 0.03;

interface RedTeam {
	about: string;
	thread: FixtureThread;
	judge: [string, string, JudgeVerdict][];
	expect: Record<string, unknown>[];
}

const redteam = ['retraction-after-confirmation', 'contradicted-police-statement', 'aggregator-echo', 'stale-date', 'single-tier2-confirmed']
	.map((name) => ({ name, ...loadJson<RedTeam>(join(EVAL_DIR, 'redteam', `${name}.json`)) }));

describe('ledger red-team fixtures', () => {
	for (const fixture of redteam) {
		it(`${fixture.name}: ${fixture.about}`, async () => {
			const cassette = new Cassette('/dev/null/none');
			for (const [a, b, verdict] of fixture.judge) cassette.verdicts[pairKey(a, b)] = verdict;
			const replay = await replayThread(fixture.thread, cassette.judge, 'events', { evidence: EVIDENCE });
			const find = (text: string) => replay.live.find((s) => s.claim.includes(text));
			for (const rule of fixture.expect.filter((r) => (r.phase as number) <= LEDGER_PHASE)) {
				if (typeof rule.live === 'number') expect(replay.live, JSON.stringify(rule)).toHaveLength(rule.live);
				if (typeof rule.claim !== 'string') continue;
				const state = find(rule.claim);
				expect(state, `claim "${rule.claim}"`).toBeDefined();
				if (rule.status) expect(state!.status).toBe(rule.status);
				if (rule.not_status) expect(state!.status).not.toBe(rule.not_status);
				if (typeof rule.needs_check === 'boolean') expect(state!.needsCheck).toBe(rule.needs_check);
				if (rule.check_reason) expect(state!.checkReason).toBe(rule.check_reason);
				if (rule.contradicts) expect(state!.contradicts).toContain(find(rule.contradicts as string)!.id);
				if (typeof rule.attribution_required === 'boolean') expect(attributionRequired(state!.status)).toBe(rule.attribution_required);
				if (rule.events) expect(replay.events.filter((e) => e.claimId === state!.id).map((e) => e.kind)).toEqual(rule.events);
			}
		});
	}
});

describe('ledger golden set', () => {
	const threads = loadThreads(join(EVAL_DIR, 'fixtures'));
	const labelled = threads.filter((t) => existsSync(join(EVAL_DIR, 'golden', `${t.id}.json`)));

	it.skipIf(!labelled.length && !process.env.LEDGER_EVAL_JUDGE_URL)('meets the duplicate target with no wrong merges, and reports before/after', async () => {
		const cassette = new Cassette(join(EVAL_DIR, 'judge-cassette.json'));
		const recordUrl = process.env.LEDGER_EVAL_JUDGE_URL;
		const judge = recordUrl ? cassette.recording(recordUrl, process.env.LEDGER_EVAL_JUDGE_TOKEN || '') : cassette.judge;
		// Record mode covers every fixture, labelled or not, so labels can land later without new judge calls.
		if (recordUrl) for (const thread of threads) await replayThread(thread, judge);
		const legacy = [];
		const eventLog = [];
		const after = [];
		for (const thread of labelled) {
			const labels = loadJson<GoldenLabels>(join(EVAL_DIR, 'golden', `${thread.id}.json`));
			legacy.push(scoreThread(await replayThread(thread, null, 'exact'), labels));
			eventLog.push(scoreThread(await replayThread(thread, judge), labels));
			after.push(scoreThread(await replayThread(thread, judge, 'events', { evidence: EVIDENCE }), labels));
		}
		const report = {
			labelledThreads: labelled.length,
			confirmedByPerson: after.filter((s) => s.labeledBy !== 'suggested').length,
			phase: LEDGER_PHASE,
			/** The pre-rework upsert (exact wording only, model status as given). */
			before: summarize(legacy),
			/** Phase 1: event log and matcher, model status as given. */
			phase1: summarize(eventLog),
			after: summarize(after),
			unrecordedJudgePairs: cassette.missing.length,
			perThread: after
		};
		if (recordUrl) cassette.save();
		writeFileSync(join(EVAL_DIR, 'report.json'), JSON.stringify(report, null, 1) + '\n');
		console.log(JSON.stringify({ before: report.before, phase1: report.phase1, after: report.after, unrecordedJudgePairs: report.unrecordedJudgePairs }));
		if (!labelled.length) return;
		expect(cassette.missing, 'record the judge cassette (pnpm eval:ledger:record)').toHaveLength(0);
		expect(report.after.duplicateRate!).toBeLessThan(TARGET_DUPLICATE_RATE);
		expect(report.after.wrongMerges).toBe(0);
		if (LEDGER_PHASE >= 2) expect(report.after.confirmedUnbacked, 'confirmed without an official source or two independent tier-2 outlets').toBe(0);
	}, 600_000);
});
