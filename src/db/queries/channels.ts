import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { channels } from "@/db/schema";

export async function listChannels(workspaceId: string) {
  return db
    .select()
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId))
    .orderBy(asc(channels.sortOrder), asc(channels.name));
}

export async function getChannelById(id: string) {
  const rows = await db.select().from(channels).where(eq(channels.id, id));
  return rows[0] ?? null;
}

export async function getChannelBySlug(workspaceId: string, slug: string) {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.slug, slug)));
  return rows[0] ?? null;
}
