import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { newsSources, type NewsSourceRow } from "@/db/schema";

export async function listSources(workspaceId: string): Promise<NewsSourceRow[]> {
  return db
    .select()
    .from(newsSources)
    .where(eq(newsSources.workspaceId, workspaceId));
}

export async function addSource(input: {
  workspaceId: string;
  url: string;
  label: string;
  kind: "rss" | "html";
}): Promise<NewsSourceRow> {
  const row: NewsSourceRow = {
    id: nanoid(),
    workspaceId: input.workspaceId,
    url: input.url,
    label: input.label,
    kind: input.kind,
    createdAt: Date.now(),
    lastCheckedAt: null,
  };
  await db.insert(newsSources).values(row).onConflictDoNothing();
  return row;
}

export async function removeSource(workspaceId: string, urlOrId: string) {
  await db
    .delete(newsSources)
    .where(
      and(
        eq(newsSources.workspaceId, workspaceId),
        urlOrId.startsWith("http")
          ? eq(newsSources.url, urlOrId)
          : eq(newsSources.id, urlOrId),
      ),
    );
}
