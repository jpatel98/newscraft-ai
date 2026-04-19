import {
  getFirstUser,
  getUserByEmail,
  getWorkspaceById,
  getWorkspaceMembership,
} from "@/db/queries/access";
import type { UserRow, WorkspaceMembershipRow, WorkspaceRow } from "@/db/schema";

export const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_DEV_USER_EMAIL = "admin@newscraft.local";

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

  const email = process.env.NEWSCRAFT_DEV_USER_EMAIL ?? DEFAULT_DEV_USER_EMAIL;
  const user = (await getUserByEmail(email)) ?? (await getFirstUser());
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
    throw new Error("No workspace membership found for the current actor.");
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
    throw new Error("Current actor is not allowed to administer this workspace.");
  }
  return context;
}
