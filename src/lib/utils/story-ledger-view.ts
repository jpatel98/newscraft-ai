import { AIR_BUCKET_LABELS, AIR_BUCKETS, airBucket, attributionFor, type AirBucket } from './claim-air';
import type { LedgerStatus } from './story-ledger';

/** Wire shape returned by GET /api/conversations/[id]/ledger and sent to the worker. */
export interface StoryLedgerClaimView {
	id: string;
	claim: string;
	status: LedgerStatus;
	attributed_to: string;
	citations: number[];
	date: string;
	needs_check: boolean;
	updated_at: string;
	/** Who settled this claim by hand, and when (ISO); absent when only the model has set it. */
	reviewed_by?: string | null;
	reviewed_at?: string | null;
	first_seen_message_id?: string | null;
	last_updated_message_id?: string | null;
	/** The status the model gave; `status` is what the cited sources support. */
	suggested_status?: LedgerStatus | null;
	/** Best tier among the claim's sources and the number of independent publishers, kept apart. */
	source_tier?: string | null;
	corroboration?: number;
	/** The pages this claim cites, resolved against the answer that cited them. */
	sources?: StoryLedgerSourceView[];
	/** Why the open check is open: model, contradicted, stale or person. */
	check_reason?: string | null;
}

export interface StoryLedgerSourceView {
	n: number;
	url: string;
	host: string;
	tier: string;
	date: string;
}

/** One ledger event as GET /api/conversations/[id]/ledger?since=<seq> returns it. */
export interface StoryLedgerChangeView {
	seq: number;
	claim_id: string;
	kind: string;
	actor: string;
	actor_name: string;
	data: Record<string, unknown>;
	at: string;
}

/** Body of PATCH /api/conversations/[id]/ledger/[claimId]: a person's call on one claim. */
export interface StoryClaimReviewInput {
	status?: LedgerStatus;
	needs_check?: boolean;
}

export const LEDGER_STATUS_LABELS: Record<LedgerStatus, string> = {
	confirmed: 'Confirmed',
	alleged: 'Alleged',
	reported: 'Reported',
	unverified: 'Unverified',
	retracted: 'Retracted'
};

export interface LedgerGroup {
	bucket: AirBucket;
	label: string;
	claims: StoryLedgerClaimView[];
}

/** Groups claims by what a producer can do with them on air; empty groups are omitted. */
export function groupLedgerClaims(
	claims: readonly StoryLedgerClaimView[],
	options: { openChecksOnly?: boolean } = {}
): LedgerGroup[] {
	const visible = options.openChecksOnly ? claims.filter((claim) => claim.needs_check) : claims;
	return AIR_BUCKETS.map((bucket) => ({
		bucket,
		label: AIR_BUCKET_LABELS[bucket],
		claims: visible.filter((claim) => airBucket(claim) === bucket)
	})).filter((group) => group.claims.length > 0);
}

/** Order of the Story button's meter blocks: what can air first, open checks last. */
const METER_ORDER: readonly AirBucket[] = ['safe', 'careful', 'hold', 'check'];

/**
 * Splits `slots` meter blocks across air buckets in proportion to their claims
 * (largest remainder), so every non-empty bucket gets at least one block when
 * there are enough to go round. Returns [] for an empty ledger.
 */
export function ledgerMeter(claims: readonly StoryLedgerClaimView[], slots = 5): AirBucket[] {
	if (!claims.length) return [];
	const counts = METER_ORDER.map((bucket) => claims.filter((claim) => airBucket(claim) === bucket).length);
	const total = Math.min(slots, claims.length);
	const exact = counts.map((n) => (n * total) / claims.length);
	const blocks = exact.map(Math.floor);
	// Hand a block to any non-empty bucket that rounded to zero, then by largest remainder.
	const order = counts
		.map((n, i) => ({ i, empty: blocks[i] === 0 && n > 0, rest: exact[i] - blocks[i] }))
		.sort((a, b) => Number(b.empty) - Number(a.empty) || b.rest - a.rest);
	for (let k = 0, left = total - blocks.reduce((a, b) => a + b, 0); left > 0; k++, left--) {
		blocks[order[k % order.length].i]++;
	}
	return METER_ORDER.flatMap((bucket, i) => Array<AirBucket>(blocks[i]).fill(bucket));
}

/** Plain-text brief grouped by air readiness, with the attribution to use for each claim. */
export function ledgerBrief(claims: readonly StoryLedgerClaimView[]): string {
	const groups = groupLedgerClaims(claims);
	if (!groups.length) return '';
	const sections = groups.map((group) => {
		const lines = group.claims.map((claim) => {
			const attribution = attributionFor(claim);
			const details = [LEDGER_STATUS_LABELS[claim.status].toLowerCase(), claim.date].filter(Boolean);
			const markers = claim.citations.map((number) => `[${number}]`).join('');
			return `- ${claim.claim} (${details.join(', ')})${markers ? ` ${markers}` : ''}${
				attribution.required && attribution.phrase ? `\n  Say: "${attribution.phrase}"` : ''
			}${claim.needs_check ? `\n  NEEDS CHECK${claim.check_reason ? `: ${CHECK_REASON[claim.check_reason] ?? claim.check_reason}` : ''}` : ''}${
				claim.reviewed_by ? ` (checked by ${claim.reviewed_by})` : ''
			}`;
		});
		return `${group.label.toUpperCase()}\n${lines.join('\n')}`;
	});
	return `STORY LEDGER\n\n${sections.join('\n\n')}\n`;
}

export interface LedgerChangeLine {
	claimId: string;
	/** The claim as it reads now (or the wording at the time, when it is no longer live). */
	claim: string;
	/** What changed, in a producer's words. */
	what: string;
	at: string;
}

const STATUS_WORD: Record<string, string> = {
	confirmed: 'confirmed',
	alleged: 'alleged',
	reported: 'reported',
	unverified: 'unverified',
	retracted: 'retracted'
};

export const CHECK_REASON: Record<string, string> = {
	model: 'the research flagged it',
	contradicted: 'sources disagree',
	stale: 'the newest source is old',
	person: 'flagged by hand'
};

/**
 * Ledger events since the person last looked, one line per claim and change
 * that matters to air (new claim, status move, conflict, check opened or
 * cleared, retraction). Rewordings of a claim already shown are left out.
 */
export function ledgerChangeLines(
	changes: readonly StoryLedgerChangeView[],
	claims: readonly StoryLedgerClaimView[]
): LedgerChangeLine[] {
	const live = new Map(claims.map((claim) => [claim.id, claim.claim]));
	const created = new Set(changes.filter((c) => c.kind === 'asserted' && c.data.first === true).map((c) => c.claim_id));
	const lines: LedgerChangeLine[] = [];
	const seen = new Set<string>();
	for (const change of changes) {
		const wording = typeof change.data.text === 'string' ? change.data.text : '';
		const claim = live.get(change.claim_id) ?? wording;
		if (!claim) continue;
		const by = change.actor === 'person' && change.actor_name ? ` by ${change.actor_name}` : '';
		let what = '';
		switch (change.kind) {
			case 'asserted':
				what = created.has(change.claim_id) ? 'New' : '';
				break;
			case 'status_changed': {
				const from = String(change.data.from ?? '');
				const to = String(change.data.to ?? '');
				if (from === to) what = change.actor === 'person' ? `Checked${by}` : '';
				else what = `${STATUS_WORD[from] ?? from} → ${STATUS_WORD[to] ?? to}${change.actor === 'system' ? ' (sources)' : by}`;
				break;
			}
			case 'retracted':
				what = `Retracted${by}`;
				break;
			case 'contradicted':
				what = 'Conflicts with another claim';
				break;
			case 'check_opened':
				what = `Needs check: ${CHECK_REASON[String(change.data.reason ?? '')] ?? 'flagged'}${by}`;
				break;
			case 'check_closed':
				what = `Check cleared${by}`;
				break;
		}
		if (!what) continue;
		const key = `${change.claim_id}\u0000${what}`;
		if (seen.has(key)) continue;
		seen.add(key);
		lines.push({ claimId: change.claim_id, claim, what, at: change.at });
	}
	return lines;
}
