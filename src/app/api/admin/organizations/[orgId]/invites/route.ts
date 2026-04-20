import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  getOrganizationById,
  getOrganizationMembership,
  getUserById,
} from "@/db/queries/access";
import { createOrganizationInvite } from "@/db/queries/organization-invites";
import { getSessionUserId } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
});

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/organizations/[orgId]/invites">,
) {
  const userId = await getSessionUserId();
  if (!userId) {
    return Response.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const user = await getUserById(userId);
  if (!user) {
    return Response.json({ ok: false, error: "Session user not found." }, { status: 401 });
  }

  const { orgId } = await context.params;
  const [organization, membership] = await Promise.all([
    getOrganizationById(orgId),
    getOrganizationMembership(orgId, user.id),
  ]);
  if (!organization) {
    return Response.json({ ok: false, error: "Organization not found." }, { status: 404 });
  }
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    return Response.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;
  await createOrganizationInvite({
    organizationId: organization.id,
    email: body.email,
    role: body.role,
    tokenHash: hashToken(token),
    expiresAt,
    invitedByUserId: user.id,
  });

  return Response.json({
    ok: true,
    organizationId: organization.id,
    inviteUrl: `/api/invites/accept?token=${token}`,
    expiresAt,
  });
}
