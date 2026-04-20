import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db/client";
import {
  organizationMemberships,
  organizations,
  workspaceMemberships,
  workspaces,
} from "@/db/schema";

export type OrganizationRole = "owner" | "admin" | "member" | "viewer";

export async function createOrganization(input: {
  slug: string;
  name: string;
  createdByUserId: string;
}) {
  const now = Date.now();
  const organizationId = nanoid();
  const workspaceId = nanoid();

  await db.insert(organizations).values({
    id: organizationId,
    slug: input.slug,
    name: input.name,
    status: "active",
    createdAt: now,
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    slug: "main",
    name: `${input.name} Main`,
    createdAt: now,
  });

  await db.insert(organizationMemberships).values({
    organizationId,
    userId: input.createdByUserId,
    role: "owner",
    createdAt: now,
  });

  await db.insert(workspaceMemberships).values({
    workspaceId,
    userId: input.createdByUserId,
    role: "owner",
    createdAt: now,
  });

  return {
    organizationId,
    workspaceId,
    workspaceSlug: "main",
  };
}

export async function listOrganizationWorkspaces(organizationId: string) {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId))
    .orderBy(asc(workspaces.createdAt));
}

export async function addOrganizationMember(input: {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}) {
  await db
    .insert(organizationMemberships)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
      set: {
        role: input.role,
      },
    });
}
