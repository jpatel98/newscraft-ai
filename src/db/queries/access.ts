import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import {
  organizationMemberships,
  organizations,
  users,
  workspaceMemberships,
  workspaces,
} from "@/db/schema";

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

export async function getFirstWorkspace() {
  const rows = await db.select().from(workspaces).limit(1);
  return rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  name: string;
  globalRole?: "user" | "admin";
}) {
  const email = input.email.toLowerCase().trim();
  const name = input.name.trim() || email;
  const globalRole = input.globalRole ?? "user";

  const existing = await getUserByEmail(email);
  if (existing) return existing;

  const row = {
    id: nanoid(),
    email,
    name,
    globalRole,
    createdAt: Date.now(),
  };

  await db.insert(users).values(row);
  return row;
}

export async function ensureUserMembershipInFirstWorkspace(userId: string) {
  const defaultWorkspace = await getFirstWorkspace();
  if (!defaultWorkspace) return null;

  await db
    .insert(organizationMemberships)
    .values({
      organizationId: defaultWorkspace.organizationId,
      userId,
      role: "member",
      createdAt: Date.now(),
    })
    .onConflictDoNothing();

  await db
    .insert(workspaceMemberships)
    .values({
      workspaceId: defaultWorkspace.id,
      userId,
      role: "member",
      createdAt: Date.now(),
    })
    .onConflictDoNothing();

  return defaultWorkspace;
}

export async function getOrganizationBySlug(slug: string) {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug));
  return rows[0] ?? null;
}

export async function getOrganizationById(id: string) {
  const rows = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, id));
  return rows[0] ?? null;
}

export async function getWorkspaceBySlug(organizationId: string, slug: string) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.slug, slug),
      ),
    );
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

export async function getOrganizationMembership(
  organizationId: string,
  userId: string,
) {
  const rows = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    );
  return rows[0] ?? null;
}

export async function getDefaultWorkspaceForUser(userId: string) {
  const rows = await db
    .select({
      workspace: workspaces,
      organization: organizations,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
    .where(eq(workspaceMemberships.userId, userId))
    .orderBy(asc(workspaces.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
