/**
 * Broadcast copy from the story ledger. Only claims that may go to air are
 * offered to the writer (no open checks, nothing unverified or withdrawn), each
 * with the attribution phrase it must carry. The writer tags every sentence
 * with the claims it states; before anyone sees the copy, every sentence that
 * states a reported or alleged claim is checked for one of that claim's allowed
 * wordings, and a sentence that lost it gets the phrase put back.
 */
import { airBucket, attributionFor, creditsFor, type AirClaim } from './claim-air';
import { cosine, embedClaim } from './claim-similarity';

export const COPY_FORMATS = ['intro', 'vo', 'reader'] as const;
export type CopyFormat = (typeof COPY_FORMATS)[number];
export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = { intro: 'Anchor intro', vo: 'VO', reader: 'Reader' };

export interface CopyClaim extends AirClaim {
	id: string;
	claim: string;
}

export interface CopyRequestClaim {
	id: string;
	claim: string;
	say: string;
}

export interface CopyLine {
	claims: string[];
	text: string;
}

/** Short ids for the writer, so long database ids never reach the prompt. */
export function copyRequest(claims: readonly CopyClaim[]): {
	request: CopyRequestClaim[];
	byRef: Map<string, CopyClaim>;
	/** Claims kept off air: open checks, unverified, withdrawn. */
	withheld: CopyClaim[];
} {
	const byRef = new Map<string, CopyClaim>();
	const request: CopyRequestClaim[] = [];
	const withheld: CopyClaim[] = [];
	for (const claim of claims) {
		const bucket = airBucket(claim);
		if (bucket !== 'safe' && bucket !== 'careful') {
			withheld.push(claim);
			continue;
		}
		const ref = `c${request.length + 1}`;
		const attribution = attributionFor(claim);
		byRef.set(ref, claim);
		request.push({ id: ref, claim: claim.claim, say: attribution.required ? attribution.phrase : '' });
	}
	return { request, byRef, withheld };
}

function fold(text: string): string {
	return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

/** Words that hang a statement on a source when the source is named in the same sentence. */
const ATTRIBUTION_CUE =
	/\b(?:according to|says?|said|reports?|reported|reporting|alleges?|alleged|allegedly|accus\w*|charged|announced|announces|confirms?|confirmed|anticipates?|lists?|listed|states?|stated|told|tells|warned|warns|calls?|called|estimates?|estimated|expects?|puts?)\b/;

/**
 * A sentence keeps a claim's attribution when it contains one of the claim's
 * allowed wordings, or names one of the claim's sources together with an
 * attribution word ("Toronto police allege", "according to TSN and the Canadian Press").
 */
export function keepsAttribution(sentence: string, claim: AirClaim): boolean {
	const attribution = attributionFor(claim);
	if (!attribution.required) return true;
	const text = fold(sentence);
	if (attribution.allowed.some((phrase) => text.includes(fold(phrase)))) return true;
	if (claim.status === 'unverified' || claim.status === 'retracted') return false;
	return ATTRIBUTION_CUE.test(text) && creditsFor(claim).some((name) => text.includes(fold(name)));
}

/** An untagged sentence this close to a claim is treated as stating it. */
export const RESTATES_SCORE = 0.5;

/** Claims each line states: its tags, or for an untagged line, any attribution-bound claim it closely restates. */
export function claimsStated(line: CopyLine, byRef: ReadonlyMap<string, CopyClaim>): CopyClaim[] {
	const out = line.claims.map((ref) => byRef.get(ref)).filter((claim): claim is CopyClaim => Boolean(claim));
	if (out.length) return out;
	const vector = embedClaim(line.text);
	for (const claim of byRef.values()) {
		if (out.includes(claim) || !attributionFor(claim).required) continue;
		if (cosine(vector, embedClaim(claim.claim)) >= RESTATES_SCORE) out.push(claim);
	}
	return out;
}

export interface LostAttribution {
	line: number;
	claimId: string;
	text: string;
}

export function lostAttributions(lines: readonly CopyLine[], byRef: ReadonlyMap<string, CopyClaim>): LostAttribution[] {
	const lost: LostAttribution[] = [];
	lines.forEach((line, index) => {
		for (const claim of claimsStated(line, byRef)) {
			if (!keepsAttribution(line.text, claim)) lost.push({ line: index, claimId: claim.id, text: line.text });
		}
	});
	return lost;
}

const LOWER_FIRST = /^(?:The|A|An|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|This|That|These|Those|It|Its|There|Some|Several|Most|All|No|Both|Each|At|In|On|About|More|Fewer|Only)\b/;

function lowerFirst(sentence: string): string {
	return LOWER_FIRST.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
}

/** Put the attribution back into one sentence for one claim. */
export function attribute(sentence: string, claim: AirClaim): string {
	const { phrase } = attributionFor(claim);
	if (!phrase) return sentence;
	// "They allege it..." / "He said..." -> name the source as the subject.
	const pronoun = /^(?:They|He|She|It)\s+(?=(?:allege|alleges|alleged|say|says|said|report|reports|reported)\b)/.exec(sentence.trim());
	const credit = phrase.replace(/^according to\s+/i, '').replace(/\s+(?:alleges?|confirms?)$/i, '');
	if (pronoun && credit) return credit + ' ' + sentence.trim().slice(pronoun[0].length);
	const body = lowerFirst(sentence.trim());
	const lead = phrase[0].toUpperCase() + phrase.slice(1);
	return /^according to /i.test(phrase) ? `${lead}, ${body}` : `${lead} that ${body}`;
}

export interface CheckedCopy {
	lines: CopyLine[];
	/** Sentences that lost an attribution and had it put back. */
	repaired: number;
	/** Sentences dropped because they named no air-ready claim or restated a withheld one. */
	dropped: number;
}

function restatesWithheld(line: CopyLine, withheld: readonly CopyClaim[]): boolean {
	const vector = embedClaim(line.text);
	return withheld.some((claim) => cosine(vector, embedClaim(claim.claim)) >= RESTATES_SCORE);
}

/** Drop sentences that state nothing air-ready or restate a withheld claim, and put lost attributions back. */
export function checkCopy(
	lines: readonly CopyLine[],
	byRef: ReadonlyMap<string, CopyClaim>,
	withheld: readonly CopyClaim[] = []
): CheckedCopy {
	let repaired = 0;
	let dropped = 0;
	const out: CopyLine[] = [];
	for (const line of lines) {
		const stated = claimsStated(line, byRef);
		if (!stated.length || (!line.claims.length && restatesWithheld(line, withheld))) {
			dropped += 1;
			continue;
		}
		let text = line.text;
		for (const claim of stated) {
			if (keepsAttribution(text, claim)) continue;
			text = attribute(text, claim);
			repaired += 1;
		}
		out.push({ claims: line.claims, text });
	}
	return { lines: out, repaired, dropped };
}

/** Paste-ready copy: uppercase, one sentence after another, as the house OC/VO style reads. */
export function renderCopy(format: CopyFormat, lines: readonly CopyLine[]): string {
	const body = lines.map((line) => line.text.trim()).join(' ').toUpperCase();
	return format === 'vo' ? `{VO}\n${body}` : body;
}
