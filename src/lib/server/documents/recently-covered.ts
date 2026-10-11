import { MAX_RECENTLY_COVERED } from './validation';

/** Placeholder titles that say nothing about what a thread covered. */
const PLACEHOLDER_TITLES = new Set(['', 'new conversation', 'new chat', 'untitled']);

export interface RecentThreadSubject {
	title: string;
	updatedAt: number;
}

export interface ManualRecentlyCovered {
	subject: string;
	coveredAt: number;
}

/**
 * Subjects sent to the worker as `recentlyCovered`: the producer's manual
 * entries merged with recent thread titles, newest first, deduped
 * case-insensitively, capped at `limit`. The manual entry keeps its position
 * when a thread repeats it.
 */
export function mergeRecentlyCoveredSubjects(
	manual: ReadonlyArray<ManualRecentlyCovered>,
	threads: ReadonlyArray<RecentThreadSubject>,
	limit: number = MAX_RECENTLY_COVERED
): string[] {
	const candidates: Array<{ subject: string; at: number }> = [];
	for (const entry of manual) {
		const subject = entry.subject.replace(/\s+/g, ' ').trim();
		if (subject) candidates.push({ subject, at: entry.coveredAt });
	}
	for (const thread of threads) {
		const subject = thread.title.replace(/\s+/g, ' ').trim();
		if (PLACEHOLDER_TITLES.has(subject.toLowerCase())) continue;
		candidates.push({ subject, at: thread.updatedAt });
	}
	// Stable sort: on equal timestamps manual entries (pushed first) win.
	candidates.sort((a, b) => b.at - a.at);
	const seen = new Set<string>();
	const subjects: string[] = [];
	for (const candidate of candidates) {
		const key = candidate.subject.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		subjects.push(candidate.subject);
		if (subjects.length >= limit) break;
	}
	return subjects;
}
