// Subsequence-with-bonuses scorer. Each query character must appear in order
// in the candidate. Empty query → score 0 (caller decides ordering).

export interface FuzzyHit<T> {
	item: T;
	score: number;
}

export function fuzzyScore(query: string, candidate: string): number {
	if (!query) return 0;
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	let qi = 0;
	let score = 0;
	let prevMatch = -2;
	let firstMatch = -1;
	for (let ci = 0; ci < c.length && qi < q.length; ci++) {
		if (c[ci] !== q[qi]) continue;
		if (firstMatch === -1) firstMatch = ci;
		if (ci === 0) score += 10;
		else {
			const prev = c[ci - 1];
			if (prev === ' ' || prev === '-' || prev === '_' || prev === '/') score += 5;
		}
		if (ci === prevMatch + 1) score += 3;
		prevMatch = ci;
		qi++;
	}
	if (qi < q.length) return -1;
	return score;
}

export function fuzzyRank<T>(
	query: string,
	items: T[],
	getText: (t: T) => string
): FuzzyHit<T>[] {
	if (!query) return items.map((item) => ({ item, score: 0 }));
	const hits: FuzzyHit<T>[] = [];
	for (const item of items) {
		const text = getText(item);
		const s = fuzzyScore(query, text);
		if (s >= 0) hits.push({ item, score: s });
	}
	hits.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return getText(a.item).length - getText(b.item).length;
	});
	return hits;
}
