import {
  getDefaultWorkspaceForUser,
  getFirstWorkspace,
  getOrganizationById,
  getOrganizationBySlug,
  getOrganizationMembership,
  getUserById,
  getWorkspaceBySlug,
  getWorkspaceMembership,
} from "@/db/queries/access";
import type {
  OrganizationMembershipRow,
  OrganizationRow,
  UserRow,
  WorkspaceMembershipRow,
  WorkspaceRow,
} from "@/db/schema";
import { getSessionUserId } from "./auth";

export const DEFAULT_ORG_SLUG = "newscraft";
export const DEFAULT_WORKSPACE_SLUG = "main";

export class AppAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppAuthError";
  }
}

export function isAppAuthError(error: unknown): error is AppAuthError {
  return error instanceof AppAuthError;
}

export type TenantContext = {
  organization: OrganizationRow;
  workspace: WorkspaceRow;
  user: UserRow | null;
  orgMembership: OrganizationMembershipRow | null;
  workspaceMembership: WorkspaceMembershipRow | null;
};

export type AuthenticatedTenantContext = {
  organization: OrganizationRow;
  workspace: WorkspaceRow;
  user: UserRow;
  orgMembership: OrganizationMembershipRow;
  workspaceMembership: WorkspaceMembershipRow;
};

async function getSessionUser() {
  const userId = await getSessionUserId();
  if (!userId) return null;
  return getUserById(userId);
}

export async function getTenantContext(
  orgSlug: string,
  workspaceSlug: string,
): Promise<TenantContext | null> {
  const organization = await getOrganizationBySlug(orgSlug);
  if (!organization) return null;
  const workspace = await getWorkspaceBySlug(organization.id, workspaceSlug);
  if (!workspace) return null;

  const user = await getSessionUser();
  const [orgMembership, workspaceMembership] = user
    ? await Promise.all([
        getOrganizationMembership(organization.id, user.id),
        getWorkspaceMembership(workspace.id, user.id),
      ])
    : [null, null];

  return {
    organization,
    workspace,
    user,
    orgMembership,
    workspaceMembership,
  };
}

export async function requireTenantContext(
  orgSlug: string,
  workspaceSlug: string,
): Promise<AuthenticatedTenantContext> {
  const context = await getTenantContext(orgSlug, workspaceSlug);
  if (!context) {
    throw new AppAuthError("Organization or workspace not found.");
  }
  if (!context.user || !context.orgMembership || !context.workspaceMembership) {
    throw new AppAuthError("Sign in is required to access this workspace.");
  }
  return {
    organization: context.organization,
    workspace: context.workspace,
    user: context.user,
    orgMembership: context.orgMembership,
    workspaceMembership: context.workspaceMembership,
  };
}

export async function requireTenantAdmin(
  orgSlug: string,
  workspaceSlug: string,
): Promise<AuthenticatedTenantContext> {
  const context = await requireTenantContext(orgSlug, workspaceSlug);
  const allowedRoles = new Set(["owner", "admin"]);
  if (
    !allowedRoles.has(context.orgMembership.role) &&
    !allowedRoles.has(context.workspaceMembership.role)
  ) {
    throw new AppAuthError(
      "Current actor is not allowed to administer this workspace.",
    );
  }
  return context;
}

export async function getDefaultTenantRouteForUser(userId: string) {
  const joined = await getDefaultWorkspaceForUser(userId);
  if (!joined) return null;
  return {
    organization: joined.organization,
    workspace: joined.workspace,
    href: `/o/${joined.organization.slug}/w/${joined.workspace.slug}`,
  };
}

export async function resolveDefaultTenantRoute() {
  const user = await getSessionUser();
  if (user) {
    const joined = await getDefaultWorkspaceForUser(user.id);
    if (joined) {
      return `/o/${joined.organization.slug}/w/${joined.workspace.slug}`;
    }
  }

  // Compatibility for bootstrapping: route to first workspace in DB.
  const fallbackWorkspace = await getFirstWorkspace();
  if (!fallbackWorkspace) return null;
  const org = await getOrganizationById(fallbackWorkspace.organizationId);
  if (!org) return null;
  return `/o/${org.slug}/w/${fallbackWorkspace.slug}`;
}

// Legacy wrappers for code paths that still call workspace-only helpers.
export type CurrentAppContext = {
  workspace: WorkspaceRow;
  user: UserRow | null;
  membership: WorkspaceMembershipRow | null;
};

export type AuthenticatedAppContext = {
  workspace: WorkspaceRow;
  user: UserRow;
  membership: WorkspaceMembershipRow;
};

export async function getCurrentAppContext(): Promise<CurrentAppContext> {
  const user = await getSessionUser();
  if (!user) {
    const firstWorkspace = await getFirstWorkspace();
    if (!firstWorkspace) {
      throw new Error(
        "Workspace not seeded. Run `npm run db:migrate` and `npm run db:seed`.",
      );
    }
    return {
      workspace: firstWorkspace,
      user: null,
      membership: null,
    };
  }

  const joined = await getDefaultWorkspaceForUser(user.id);
  if (!joined) {
    throw new Error(
      "User has no workspace membership. Seed data or create an organization.",
    );
  }
  const membership = await getWorkspaceMembership(joined.workspace.id, user.id);
  return {
    workspace: joined.workspace,
    user,
    membership,
  };
}

export async function requireWorkspaceMembership(): Promise<AuthenticatedAppContext> {
  const context = await getCurrentAppContext();
  if (!context.user || !context.membership) {
    throw new AppAuthError("Sign in is required to access this workspace.");
  }
  return {
    workspace: context.workspace,
    user: context.user,
    membership: context.membership,
  };
}

export async function requireWorkspaceAdmin(): Promise<AuthenticatedAppContext> {
  const context = await requireWorkspaceMembership();
  if (
    context.membership.role !== "owner" &&
    context.membership.role !== "admin"
  ) {
    throw new AppAuthError(
      "Current actor is not allowed to administer this workspace.",
    );
  }
  return context;
}
