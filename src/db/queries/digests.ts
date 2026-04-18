import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { digests, type DigestRow } from "@/db/schema";

export async function getDigestByDate(
  workspaceId: string,
  dateKey: string,
): Promise<DigestRow | null> {
  const rows = await db
    .select()
    .from(digests)
    .where(and(eq(digests.workspaceId, workspaceId), eq(digests.dateKey, dateKey)));
  return rows[0] ?? null;
}

export async function insertDigest(input: {
  workspaceId: string;
  channelId: string;
  messageId: string;
  dateKey: string;
  items: unknown[];
}): Promise<DigestRow> {
  const row: DigestRow = {
    id: nanoid(),
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    messageId: input.messageId,
    dateKey: input.dateKey,
    items: input.items,
    createdAt: Date.now(),
  };
  await db
    .insert(digests)
    .values(row)
    .onConflictDoUpdate({
      target: [digests.workspaceId, digests.dateKey],
      set: {
        channelId: input.channelId,
        messageId: input.messageId,
        items: input.items,
        createdAt: row.createdAt,
      },
    });
  return row;
}
