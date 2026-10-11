import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { newsroomProfiles } from '$lib/server/db/schema';
import type { NewsroomProfileRow } from './types';
import { normalizeNewsroomProfile } from './validation';

export async function getNewsroomProfile(orgId: string): Promise<NewsroomProfileRow | undefined> {
	const [row] = (await db
		.select()
		.from(newsroomProfiles)
		.where(eq(newsroomProfiles.orgId, orgId))
		.limit(1)) as NewsroomProfileRow[];
	return row;
}

export async function upsertNewsroomProfile(
	orgId: string,
	input: {
		timezone: unknown;
		homeMarket?: unknown;
		preferredDomains?: unknown;
		showName?: unknown;
		airTimeLocal?: unknown;
		audience?: unknown;
		beats?: unknown;
		styleNotes?: unknown;
		recentlyCovered?: unknown;
	}
): Promise<NewsroomProfileRow> {
	const now = Date.now();
	// A subject that was already recorded keeps its original covered date.
	const existingCoveredAt = new Map<string, number>();
	if (input.recentlyCovered !== undefined) {
		const existing = await getNewsroomProfile(orgId);
		for (const entry of existing?.recentlyCovered ?? []) {
			existingCoveredAt.set(entry.subject.toLowerCase(), entry.coveredAt);
		}
	}
	// Show-memory fields the caller left out are absent from `profile`, so an
	// older client saving only the original fields cannot erase them.
	const profile = normalizeNewsroomProfile(input, now, existingCoveredAt);
	const [row] = (await db
		.insert(newsroomProfiles)
		.values({ orgId, ...profile, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: newsroomProfiles.orgId,
			set: { ...profile, updatedAt: now }
		})
		.returning()) as NewsroomProfileRow[];
	return row;
}
