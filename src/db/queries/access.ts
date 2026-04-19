import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users, workspaceMemberships, workspaces } from "@/db/schema";

export async function getUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email));
  return rows[0] ?? null;
}

export async function getUserById(id: string) {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

export async function getFirstUser() {
  const rows = await db.select().from(users).limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceById(id: string) {
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return rows[0] ?? null;
}

export async function getWorkspaceMembership(workspaceId: string, userId: string) {
  const rows = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId),
      ),
    );
  return rows[0] ?? null;
}
