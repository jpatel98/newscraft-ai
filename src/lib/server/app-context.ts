import {
  getUserById,
  getWorkspaceById,
  getWorkspaceMembership,
} from "@/db/queries/access";
import type { UserRow, WorkspaceMembershipRow, WorkspaceRow } from "@/db/schema";
import { getSessionUserId } from "./auth";

export const DEFAULT_WORKSPACE_ID = "default";

export class AppAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppAuthError";
  }
}

export function isAppAuthError(error: unknown): error is AppAuthError {
  return error instanceof AppAuthError;
}

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
  const workspace = await getWorkspaceById(DEFAULT_WORKSPACE_ID);
  if (!workspace) {
    throw new Error(
      "Workspace not seeded. Run `npm run db:migrate` and `npm run db:seed`.",
    );
  }

  const userId = await getSessionUserId();
  const user = userId ? await getUserById(userId) : null;
  const membership = user
    ? await getWorkspaceMembership(workspace.id, user.id)
    : null;

  return {
    workspace,
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
