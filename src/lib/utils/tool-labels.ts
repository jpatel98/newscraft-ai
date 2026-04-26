// Map raw tool names from the gateway into plain-English status copy. A tool
// can fall through several heuristics (substring match), so the final label
// is "Working on it" only when nothing else fits.

export interface ToolLabel {
	live: string;
	done: string;
}

const TABLE: Array<{ test: RegExp; label: ToolLabel }> = [
	{ test: /search|google|bing|duckduckgo|web/i, label: { live: 'Searching sources', done: 'Sources checked' } },
	{ test: /fetch|read|browse|open|http|url|page/i, label: { live: 'Reading results', done: 'Pages read' } },
	{ test: /verify|check|validate|fact/i, label: { live: 'Checking details', done: 'Details checked' } },
	{ test: /summari[sz]e|brief|outline/i, label: { live: 'Summarizing', done: 'Summary ready' } },
	{ test: /draft|write|compose/i, label: { live: 'Drafting', done: 'Draft ready' } },
	{ test: /db|sql|query|select/i, label: { live: 'Querying data', done: 'Data fetched' } }
];

export function liveLabel(name: string): string {
	for (const row of TABLE) if (row.test.test(name)) return row.label.live;
	return 'Working on it';
}

export function doneLabel(name: string): string {
	for (const row of TABLE) if (row.test.test(name)) return row.label.done;
	return 'Tools used';
}

// Dominant label for a set of running tools — picks the most common kind
// so the status copy stays calm even when many fire in parallel.
export function dominantLiveLabel(names: string[]): string {
	if (names.length === 0) return 'Drafting answer';
	const counts = new Map<string, number>();
	for (const name of names) {
		const label = liveLabel(name);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	let best = '';
	let bestCount = -1;
	for (const [label, count] of counts) {
		if (count > bestCount) {
			best = label;
			bestCount = count;
		}
	}
	return best || 'Working on it';
}

export function dominantDoneLabel(names: string[]): string {
	if (names.length === 0) return '';
	const counts = new Map<string, number>();
	for (const name of names) {
		const label = doneLabel(name);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	let best = '';
	let bestCount = -1;
	for (const [label, count] of counts) {
		if (count > bestCount) {
			best = label;
			bestCount = count;
		}
	}
	return best || 'Tools used';
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
}
