import { notFound, redirect } from "next/navigation";
import { listWorkspaceAgentRows } from "@/db/queries/agents";
import { listMessagesByChannel } from "@/db/queries/messages";
import { listChannels } from "@/db/queries/channels";
import type { AgentChatRecord } from "@/lib/agents/ui-types";
import { ChatView } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";
import { getTenantContext } from "@/lib/server/app-context";
import { getCanonicalWorkspaceChannelSlug, projectVisibleChannels } from "@/lib/workspace-channels";
import { tenantChannelPath } from "@/lib/server/tenant-path";

export default async function TenantChannelPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; slug: string }>;
}) {
  const { orgSlug, workspaceSlug, slug } = await params;
  const context = await getTenantContext(orgSlug, workspaceSlug);
  if (!context) notFound();
  if (!context.workspaceMembership) {
    redirect(
      `/login?next=${encodeURIComponent(`/o/${orgSlug}/w/${workspaceSlug}/channel/${slug}`)}`,
    );
  }

  const rawChannels = await listChannels(context.workspace.id);
  const channels = projectVisibleChannels(rawChannels);
  if (channels.length === 0) notFound();

  const canonicalSlug = getCanonicalWorkspaceChannelSlug(slug);
  if (!canonicalSlug) {
    redirect(tenantChannelPath({ orgSlug, workspaceSlug }, channels[0].slug));
  }

  const channel = channels.find((item) => item.slug === canonicalSlug);
  if (!channel) {
    redirect(tenantChannelPath({ orgSlug, workspaceSlug }, channels[0].slug));
  }
  if (slug !== canonicalSlug) {
    redirect(tenantChannelPath({ orgSlug, workspaceSlug }, canonicalSlug));
  }

  const rawMessages = await listMessagesByChannel(channel.id);
  const agents = (await listWorkspaceAgentRows(context.workspace.id))
    .filter((agent) => agent.id === "expertise-finder" || agent.id === "news-monitor")
    .map(
      (agent) =>
        ({
          id: agent.id,
          name: agent.name,
        }) satisfies AgentChatRecord,
    );

  const initialMessages: ChatMessage[] = rawMessages
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      id: row.id,
      role: row.role as ChatMessage["role"],
      agentId: row.agentId,
      content: row.content,
      payload: row.payload ?? null,
      renderer: row.renderer,
      createdAt: row.createdAt,
    }));

  return (
    <ChatView
      key={channel.id}
      channel={channel}
      agents={agents}
      initialMessages={initialMessages}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
