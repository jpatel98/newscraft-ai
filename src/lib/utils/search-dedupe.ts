// One-row-per-conversation collapse for thread search. The search backend
// can return both a title hit and one or more message hits for the same
// conversation; the sidebar shows a single best row per thread to avoid
// the noisy stack of duplicates the user reported.

export type SearchRole = 'user' | 'assistant' | 'system' | 'tool' | 'thread';

export interface SearchRow {
	conversationId: string;
	conversationTitle: string;
	messageId: string;
	role: SearchRole;
	snippet: string;
	createdAt: number;
}

// Title hits beat message hits; among message hits, newest wins. Within a
// role tier, the first row keeps its position so the caller's upstream
// ordering (rank, recency) is preserved deterministically.
export function dedupeByConversation(rows: SearchRow[]): SearchRow[] {
	const best = new Map<string, SearchRow>();
	const order: string[] = [];
	for (const row of rows) {
		const id = row.conversationId;
		const prev = best.get(id);
		if (!prev) {
			best.set(id, row);
			order.push(id);
			continue;
		}
		if (prev.role === 'thread') continue;
		if (row.role === 'thread') {
			best.set(id, row);
			continue;
		}
		if (row.createdAt > prev.createdAt) best.set(id, row);
	}
	return order.map((id) => best.get(id) as SearchRow);
}

// Lower-case whitespace tokenizer. Used by both the server and the client
// so highlight/match logic can stay in lock-step.
export function searchTokens(raw: string): string[] {
	return raw
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.map((t) => t.trim())
		.filter(Boolean);
}

// True when every token appears (case-insensitive) in the candidate. Used
// for client-side reranking of cached title hits in the command palette.
export function matchesAllTokens(text: string, tokens: string[]): boolean {
	if (tokens.length === 0) return true;
	const lower = text.toLocaleLowerCase();
	return tokens.every((t) => lower.includes(t));
}
