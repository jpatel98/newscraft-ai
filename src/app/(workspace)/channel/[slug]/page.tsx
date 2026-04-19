import { notFound } from "next/navigation";
import { listWorkspaceAgentRows } from "@/db/queries/agents";
import { getChannelBySlug } from "@/db/queries/channels";
import { listMessagesByChannel } from "@/db/queries/messages";
import { ChatView } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";
import { getCurrentAppContext } from "@/lib/server/app-context";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { workspace } = await getCurrentAppContext();
  const channel = await getChannelBySlug(workspace.id, slug);
  if (!channel) notFound();

  const rawMessages = await listMessagesByChannel(channel.id);
  const agents = await listWorkspaceAgentRows(workspace.id);

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
    />
  );
}
