import { matchesAllTokens } from './search-dedupe';

export function markSearchSnippet(text: string, terms: string[], max = 180): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (!clean) return '';
	const lower = clean.toLocaleLowerCase();
	const first = terms
		.map((t) => lower.indexOf(t))
		.filter((i) => i >= 0)
		.sort((a, b) => a - b)[0];
	const contextBefore = Math.min(40, Math.floor(max / 3));
	const start = first != null && first > contextBefore ? Math.max(0, first - contextBefore) : 0;
	const clipped = `${start > 0 ? '…' : ''}${clean.slice(start, start + max)}${
		start + max < clean.length ? '…' : ''
	}`;
	const pattern = new RegExp(
		`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
		'gi'
	);
	return clipped.replace(pattern, '<mark>$1</mark>');
}

export function visibleSearchSnippet(text: string, terms: string[], max = 180): string | null {
	if (!matchesAllTokens(text, terms)) return null;
	return markSearchSnippet(text, terms, max);
}
