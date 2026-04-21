import { notFound, redirect } from "next/navigation";
import { listChannels } from "@/db/queries/channels";
import { getTenantContext } from "@/lib/server/app-context";
import { tenantChannelPath } from "@/lib/server/tenant-path";
import { projectVisibleChannels } from "@/lib/workspace-channels";

export default async function TenantWorkspaceHome({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const context = await getTenantContext(orgSlug, workspaceSlug);
  if (!context) notFound();
  if (!context.workspaceMembership) {
    redirect(`/login?next=${encodeURIComponent(`/o/${orgSlug}/w/${workspaceSlug}`)}`);
  }

  const channels = projectVisibleChannels(await listChannels(context.workspace.id));
  if (channels.length === 0) return null;
  redirect(tenantChannelPath({ orgSlug, workspaceSlug }, channels[0].slug));
}
