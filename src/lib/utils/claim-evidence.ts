/**
 * What a claim's cited pages can establish. The model suggests a status; the
 * ledger stores the status its sources support:
 *
 *   confirmed   an official source, or two independent wire/major outlets
 *   reported    at least one source that is not an aggregator
 *   unverified  only aggregators, or nothing the citations resolve to
 *
 * "alleged" and "retracted" describe the claim itself (an accusation, a
 * withdrawn statement), and "unverified" is the model saying the answer could
 * not stand the claim up, so evidence never changes those three. Otherwise the
 * evidence decides between confirmed and reported, whatever the model said.
 * An open conflict caps a claim at reported.
 */
import { classifySource, type SourceTier, TIER_RANK } from './source-tiers';
import type { LedgerStatus } from './story-ledger';

export interface CitedPage {
	url: string;
	date?: string | null;
}

/** One cited page as the claim's own answer numbered it, with its tier and publisher. */
export interface EvidenceSource {
	n: number;
	url: string;
	host: string;
	tier: SourceTier;
	publisher: string;
	date: string;
}

export interface EvidenceSummary {
	/** Best tier among the sources, or null with no sources. */
	tier: SourceTier | null;
	/** Independent publishers behind the sources, aggregators excluded. */
	corroboration: number;
	/** The highest status these sources support. */
	ceiling: 'confirmed' | 'reported' | 'unverified';
}

/** Citation number -> page, from a run's citation records. */
export function citationSources(
	citations: readonly { citationNumber: number; url: string; publicationDate?: string | null }[]
): Map<number, CitedPage> {
	const map = new Map<number, CitedPage>();
	for (const citation of citations) {
		if (Number.isSafeInteger(citation.citationNumber) && citation.url) {
			map.set(citation.citationNumber, { url: citation.url, date: citation.publicationDate ?? '' });
		}
	}
	return map;
}

export function resolveEvidence(numbers: readonly number[], pages: ReadonlyMap<number, CitedPage>): EvidenceSource[] {
	const out: EvidenceSource[] = [];
	for (const n of numbers) {
		const page = pages.get(n);
		if (!page) continue;
		const source = classifySource(page.url);
		out.push({ n, url: page.url, host: source.host, tier: source.tier, publisher: source.publisher, date: page.date || '' });
	}
	return out;
}

/** Union by URL; the earlier entry wins so a source keeps the number it was first cited under. */
export function mergeEvidence(current: readonly EvidenceSource[], next: readonly EvidenceSource[], max = 24): EvidenceSource[] {
	const out = [...current];
	for (const source of next) if (!out.some((s) => s.url === source.url)) out.push(source);
	return out.slice(0, max);
}

export function summarizeEvidence(evidence: readonly EvidenceSource[]): EvidenceSummary {
	const usable = evidence.filter((source) => source.tier !== 'aggregator');
	const tier = evidence.length
		? evidence.reduce<SourceTier>((best, s) => (TIER_RANK[s.tier] < TIER_RANK[best] ? s.tier : best), 'aggregator')
		: null;
	const corroboration = new Set(usable.map((source) => source.publisher)).size;
	const majorPublishers = new Set(usable.filter((s) => s.tier === 'wire_major').map((s) => s.publisher)).size;
	const ceiling = usable.some((s) => s.tier === 'official') || majorPublishers >= 2 ? 'confirmed' : usable.length ? 'reported' : 'unverified';
	return { tier, corroboration, ceiling };
}

export function deriveStatus(suggested: LedgerStatus, evidence: readonly EvidenceSource[], contradicted: boolean): LedgerStatus {
	if (suggested === 'alleged' || suggested === 'retracted' || suggested === 'unverified') return suggested;
	const ceiling = summarizeEvidence(evidence).ceiling;
	return contradicted && ceiling === 'confirmed' ? 'reported' : ceiling;
}

/** A claim whose newest dated source is older than this is flagged as possibly stale. */
export const STALE_AFTER_DAYS = 180;
const DAY = 86_400_000;

function dateMs(value: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (!match) return null;
	const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return Number.isFinite(ms) ? ms : null;
}

/** True when every date we have for the claim is older than STALE_AFTER_DAYS at `at`. Undated claims are not stale. */
export function isStale(evidence: readonly EvidenceSource[], claimDate: string, at: number): boolean {
	const dates = [...evidence.map((s) => s.date), claimDate].map(dateMs).filter((ms): ms is number => ms !== null);
	if (!dates.length) return false;
	return at - Math.max(...dates) > STALE_AFTER_DAYS * DAY;
}

/** Anything short of confirmed has to be attributed on air. */
export function attributionRequired(status: LedgerStatus): boolean {
	return status !== 'confirmed';
}
