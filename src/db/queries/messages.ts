import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { messages, type MessageRow, type NewMessageRow } from "@/db/schema";

export async function listMessagesByChannel(
  channelId: string,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.channelId, channelId))
    .orderBy(asc(messages.createdAt));
}

export async function insertMessage(
  input: Omit<NewMessageRow, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  },
): Promise<MessageRow> {
  const { id: idOverride, createdAt: createdAtOverride, ...rest } = input;
  const inserted: NewMessageRow = {
    ...rest,
    id: idOverride ?? nanoid(),
    createdAt: createdAtOverride ?? Date.now(),
  };
  await db.insert(messages).values(inserted);
  return inserted as MessageRow;
}

export async function deleteMessagesByChannel(channelId: string) {
  await db.delete(messages).where(eq(messages.channelId, channelId));
}
