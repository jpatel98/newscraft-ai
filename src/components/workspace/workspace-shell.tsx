"use client";

import { useRouter } from "next/navigation";
import type { AgentRow, ChannelRow } from "@/db/schema";
import { Sidebar } from "./sidebar";
import { ChatView } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";

export type WorkspaceShellProps = {
  channels: ChannelRow[];
  agents: AgentRow[];
  activeChannel: ChannelRow;
  activeAgent: AgentRow | null;
  initialMessages: ChatMessage[];
};

export function WorkspaceShell({
  channels,
  agents,
  activeChannel,
  activeAgent,
  initialMessages,
}: WorkspaceShellProps) {
  const router = useRouter();

  const selectChannel = (channel: ChannelRow) => {
    router.push(`/?channel=${channel.slug}`);
  };

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] bg-[var(--bg)] text-[var(--fg)]">
      <Sidebar
        channels={channels}
        agents={agents}
        activeChannelId={activeChannel.id}
        onSelect={selectChannel}
      />
      <ChatView
        channel={activeChannel}
        agent={activeAgent}
        agents={agents}
        initialMessages={initialMessages}
      />
    </div>
  );
}
