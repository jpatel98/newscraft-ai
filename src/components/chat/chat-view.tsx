"use client";

import { useMemo } from "react";
import type { AgentRow, ChannelRow } from "@/db/schema";
import {
  useAgentStream,
  type ChatMessage,
} from "@/lib/hooks/use-agent-stream";
import { ChatHeader } from "./chat-header";
import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";

export type ChatViewProps = {
  channel: ChannelRow;
  agents: AgentRow[];
  initialMessages: ChatMessage[];
};

export function ChatView({ channel, agents, initialMessages }: ChatViewProps) {
  const { messages, pending, error, streaming, send, cancel } = useAgentStream({
    channelId: channel.id,
    initialMessages,
  });

  const agentMap = useMemo(
    () => new Map(agents.map((item) => [item.id, item])),
    [agents],
  );

  return (
    <>
      <ChatHeader channel={channel} />

      <MessageList
        messages={messages}
        pending={pending}
        agentMap={agentMap}
      />

      {error ? (
        <div className="mx-auto mb-2 max-w-3xl w-full px-6 text-sm text-[var(--danger)]">
          {error}
        </div>
      ) : null}

      <MessageComposer
        streaming={streaming}
        onSend={send}
        onCancel={cancel}
      />
    </>
  );
}
