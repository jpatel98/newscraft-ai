import type { NewsroomContext } from '@newscraft/shared';
import { mergeRecentlyCoveredSubjects, type RecentThreadSubject } from './recently-covered';
import type { NewsroomProfileRow } from './types';

/** Recent threads older than this are not treated as "recently covered". */
export const RECENT_THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_NEWSROOM_TIMEZONE = 'America/Toronto';

/**
 * The editorial defaults sent to the research worker. Empty show-memory fields
 * are omitted so the worker can tell "not set" from "set".
 */
export function buildNewsroomContext(
	profile: NewsroomProfileRow | undefined,
	recentThreads: ReadonlyArray<RecentThreadSubject>
): NewsroomContext {
	const recentlyCovered = mergeRecentlyCoveredSubjects(
		profile?.recentlyCovered ?? [],
		recentThreads
	);
	return {
		timezone: profile?.timezone ?? DEFAULT_NEWSROOM_TIMEZONE,
		...(profile?.homeMarket ? { homeMarket: profile.homeMarket } : {}),
		...(profile?.preferredDomains?.length ? { preferredDomains: profile.preferredDomains } : {}),
		...(profile?.showName ? { showName: profile.showName } : {}),
		...(profile?.airTimeLocal ? { airTimeLocal: profile.airTimeLocal } : {}),
		...(profile?.audience ? { audience: profile.audience } : {}),
		...(profile?.beats?.length ? { beats: profile.beats } : {}),
		...(profile?.styleNotes ? { styleNotes: profile.styleNotes } : {}),
		...(recentlyCovered.length ? { recentlyCovered } : {})
	};
}
