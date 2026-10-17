/**
 * Claim similarity for the story ledger: a small hashed embedding (content
 * words, numbers and character trigrams) compared by cosine. It runs anywhere
 * with no model or network, so the matcher and its tests are deterministic.
 * It only proposes candidates; a judge call decides paraphrase vs. conflict.
 */

const DIMENSIONS = 1024;
const STOPWORDS = new Set(
	('a an the of to in on at for and or but is are was were be been being by with from that this these those it its as ' +
		'has have had will would should could can may might says said say per after over into than more about also ' +
		'which who whom what when where while there their they them he she his her we our you your not no').split(' ')
);

export type ClaimVector = Float32Array;

function hash(text: string): number {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Lowercased, accent-free, punctuation-light text used for exact comparison. */
export function normalizeClaimText(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[‘’]/g, "'")
		.replace(/[^a-z0-9$%.,' ]+/g, ' ')
		.replace(/(\d),(\d)/g, '$1$2')
		.replace(/[.,]+(\s|$)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

const NUMBER_WORDS: Record<string, string> = Object.fromEntries(
	('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen ' +
		'seventeen eighteen nineteen twenty')
		.split(' ')
		.map((word, i) => [word, String(i)])
);

/** Numbers that appear in a claim (digits or one to twenty in words), used to spot conflicting figures. */
export function claimNumbers(text: string): string[] {
	const normalized = normalizeClaimText(text);
	const digits = (normalized.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/\.0+$/, ''));
	const spelled = normalized.split(' ').flatMap((word) => (NUMBER_WORDS[word] ? [NUMBER_WORDS[word]] : []));
	return [...new Set([...digits, ...spelled])];
}

function words(text: string): string[] {
	return normalizeClaimText(text)
		.split(' ')
		.map((word) => word.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
		.filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

function stemOf(token: string): string {
	if (/\d/.test(token) || token.length <= 4) return token;
	const stem = token.replace(/(?:ers|ing|ed|es|er|s)$/, '');
	return (stem.length >= 3 ? stem : token).slice(0, 6);
}

export function embedClaim(text: string): ClaimVector {
	const vector = new Float32Array(DIMENSIONS);
	const tokens = words(text);
	for (const token of tokens) {
		const weight = /\d/.test(token) ? 2 : 1.5;
		vector[hash(`w:${token}`) % DIMENSIONS] += weight;
		// A light stem so "approved"/"approves", "voters"/"votes" and "student"/"students" meet.
		const stem = stemOf(token);
		vector[hash(`s:${stem}`) % DIMENSIONS] += 1;
		const padded = ` ${token} `;
		for (let i = 0; i + 3 <= padded.length; i++) vector[hash(`c:${padded.slice(i, i + 3)}`) % DIMENSIONS] += 0.35;
	}
	let norm = 0;
	for (const value of vector) norm += value * value;
	norm = Math.sqrt(norm);
	if (norm > 0) for (let i = 0; i < DIMENSIONS; i++) vector[i] /= norm;
	return vector;
}

export function cosine(a: ClaimVector, b: ClaimVector): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

export interface SimilarityCandidate<T> {
	item: T;
	score: number;
}

/** Highest-scoring items for a query vector, best first. */
export function topSimilar<T>(
	query: ClaimVector,
	items: readonly T[],
	vectorOf: (item: T) => ClaimVector,
	options: { k?: number; min?: number } = {}
): SimilarityCandidate<T>[] {
	const k = options.k ?? 3;
	const min = options.min ?? 0;
	return items
		.map((item) => ({ item, score: cosine(query, vectorOf(item)) }))
		.filter((candidate) => candidate.score >= min)
		.sort((a, b) => b.score - a.score)
		.slice(0, k);
}
