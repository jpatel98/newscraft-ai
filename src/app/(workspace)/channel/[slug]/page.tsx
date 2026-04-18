import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { agents as agentsTable } from "@/db/schema";
import { getChannelBySlug } from "@/db/queries/channels";
import { listMessagesByChannel } from "@/db/queries/messages";
import { ChatView } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";

const WORKSPACE_ID = "default";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const channel = await getChannelBySlug(WORKSPACE_ID, slug);
  if (!channel) notFound();

  const rawMessages = await listMessagesByChannel(channel.id);
  const agents = await db.select().from(agentsTable);

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
