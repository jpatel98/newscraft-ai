import { notFound, redirect } from "next/navigation";
import { listWorkspaceAgentRows } from "@/db/queries/agents";
import { getChannelBySlug } from "@/db/queries/channels";
import { listMessagesByChannel } from "@/db/queries/messages";
import type { AgentChatRecord } from "@/lib/agents/ui-types";
import { ChatView } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";
import { getTenantContext } from "@/lib/server/app-context";

export default async function TenantChannelPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; slug: string }>;
}) {
  const { orgSlug, workspaceSlug, slug } = await params;
  const context = await getTenantContext(orgSlug, workspaceSlug);
  if (!context) notFound();
  if (!context.workspaceMembership) {
    redirect(`/login?next=${encodeURIComponent(`/o/${orgSlug}/w/${workspaceSlug}/channel/${slug}`)}`);
  }

  const channel = await getChannelBySlug(context.workspace.id, slug);
  if (!channel) notFound();

  const rawMessages = await listMessagesByChannel(channel.id);
  const agents = (await listWorkspaceAgentRows(context.workspace.id)).map(
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
