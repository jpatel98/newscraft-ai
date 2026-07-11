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
	input: { timezone: unknown; homeMarket?: unknown; preferredDomains?: unknown }
): Promise<NewsroomProfileRow> {
	const profile = normalizeNewsroomProfile(input);
	const now = Date.now();
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
