import { and, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { authSessions, type AuthSessionRow } from "@/db/schema";

export async function createAuthSession(input: {
  userId: string;
  tokenHash: string;
  expiresAt: number;
}): Promise<AuthSessionRow> {
  const row: AuthSessionRow = {
    id: nanoid(),
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    createdAt: Date.now(),
    revokedAt: null,
  };
  await db.insert(authSessions).values(row);
  return row;
}

export async function getActiveAuthSessionByTokenHash(tokenHash: string) {
  const rows = await db
    .select()
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, Date.now()),
      ),
    );
  return rows[0] ?? null;
}

export async function revokeAuthSessionByTokenHash(tokenHash: string) {
  await db
    .update(authSessions)
    .set({ revokedAt: Date.now() })
    .where(eq(authSessions.tokenHash, tokenHash));
}

