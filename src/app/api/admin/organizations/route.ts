import { z } from "zod";
import { db } from "@/db/client";
import { seedOrganizationAgentSettings, seedWorkspaceAgentSettings } from "@/db/queries/agents";
import { getUserById } from "@/db/queries/access";
import { createOrganization } from "@/db/queries/organizations";
import { channels } from "@/db/schema";
import { getSessionUserId } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(1),
  slug: z
    .string()
    .trim()
    .min(2)
    .regex(/^[a-z0-9-]+$/),
  templateKey: z.literal("newsroom-default"),
});

const TEMPLATE_CHANNELS = [
  { slug: "general", name: "general", sortOrder: 100 },
  { slug: "research", name: "research", sortOrder: 101 },
  { slug: "news-digest", name: "news-digest", sortOrder: 102 },
] as const;

export async function POST(request: Request) {
  const userId = await getSessionUserId();
  if (!userId) {
    return Response.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return Response.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const user = await getUserById(userId);
  if (!user) {
    return Response.json({ ok: false, error: "Session user not found." }, { status: 401 });
  }

  try {
    const created = await createOrganization({
      name: body.name,
      slug: body.slug,
      createdByUserId: user.id,
    });

    for (const topic of TEMPLATE_CHANNELS) {
      await db.insert(channels).values({
        id: `channel-${created.workspaceId}-${topic.slug}`,
        workspaceId: created.workspaceId,
        kind: "topic",
        slug: topic.slug,
        name: topic.name,
        agentId: null,
        sortOrder: topic.sortOrder,
      });
    }

    await seedOrganizationAgentSettings(created.organizationId, user);
    await seedWorkspaceAgentSettings(created.workspaceId, user);

    return Response.json({
      ok: true,
      organizationId: created.organizationId,
      workspaceId: created.workspaceId,
      href: `/o/${body.slug}/w/${created.workspaceSlug}`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not create organization.";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
