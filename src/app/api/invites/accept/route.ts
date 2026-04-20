import { createHash } from "node:crypto";
import { db } from "@/db/client";
import { getOrganizationById, getUserById } from "@/db/queries/access";
import {
  getActiveInviteByTokenHash,
  markInviteAccepted,
} from "@/db/queries/organization-invites";
import { listOrganizationWorkspaces } from "@/db/queries/organizations";
import { organizationMemberships, workspaceMemberships } from "@/db/schema";
import { getSessionUserId } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function POST(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return Response.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const user = await getUserById(userId);
  if (!user) {
    return Response.json({ ok: false, error: "Session user not found." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  if (!token) {
    return Response.json({ ok: false, error: "Missing invite token." }, { status: 400 });
  }

  const invite = await getActiveInviteByTokenHash(hashToken(token));
  if (!invite) {
    return Response.json({ ok: false, error: "Invite is invalid or expired." }, { status: 404 });
  }
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return Response.json(
      { ok: false, error: "Invite email does not match current account." },
      { status: 403 },
    );
  }

  await db
    .insert(organizationMemberships)
    .values({
      organizationId: invite.organizationId,
      userId: user.id,
      role: invite.role,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: [organizationMemberships.organizationId, organizationMemberships.userId],
      set: { role: invite.role },
    });

  const workspaces = await listOrganizationWorkspaces(invite.organizationId);
  const primaryWorkspace = workspaces[0] ?? null;
  if (primaryWorkspace) {
    await db
      .insert(workspaceMemberships)
      .values({
        workspaceId: primaryWorkspace.id,
        userId: user.id,
        role: invite.role,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
        set: { role: invite.role },
      });
  }

  await markInviteAccepted(invite.id);

  if (!primaryWorkspace) {
    return Response.json({ ok: true, accepted: true, href: "/" });
  }

  const org = await getOrganizationById(invite.organizationId);

  if (!org) {
    return Response.json({ ok: true, accepted: true, href: "/" });
  }

  return Response.json({
    ok: true,
    accepted: true,
    href: `/o/${org.slug}/w/${primaryWorkspace.slug}`,
  });
}
