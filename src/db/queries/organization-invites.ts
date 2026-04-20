import { and, eq, gt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import { organizationInvites } from "@/db/schema";

export async function createOrganizationInvite(input: {
  organizationId: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  tokenHash: string;
  expiresAt: number;
  invitedByUserId: string;
}) {
  const row = {
    id: nanoid(),
    organizationId: input.organizationId,
    email: input.email.toLowerCase().trim(),
    role: input.role,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    invitedByUserId: input.invitedByUserId,
    acceptedAt: null,
    createdAt: Date.now(),
  };
  await db.insert(organizationInvites).values(row);
  return row;
}

export async function getActiveInviteByTokenHash(tokenHash: string) {
  const rows = await db
    .select()
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.tokenHash, tokenHash),
        isNull(organizationInvites.acceptedAt),
        gt(organizationInvites.expiresAt, Date.now()),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function markInviteAccepted(id: string) {
  await db
    .update(organizationInvites)
    .set({ acceptedAt: Date.now() })
    .where(eq(organizationInvites.id, id));
}
