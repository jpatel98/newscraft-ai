import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { threads, type ThreadRow } from "@/db/schema";

export async function ensureThreadForChannel(channelId: string): Promise<ThreadRow> {
  const existing = await db
    .select()
    .from(threads)
    .where(eq(threads.channelId, channelId));

  if (existing[0]) {
    return existing[0];
  }

  const now = Date.now();
  const row: ThreadRow = {
    id: nanoid(),
    channelId,
    agentSessionId: null,
    lastResponseId: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(threads).values(row);
  return row;
}

export async function updateThreadLastResponse(
  threadId: string,
  lastResponseId: string | null,
) {
  await db
    .update(threads)
    .set({ lastResponseId, updatedAt: Date.now() })
    .where(eq(threads.id, threadId));
}
