"use client";

import { useEffect, useRef } from "react";
import type { ChannelRow } from "@/db/schema";
import type { AgentChatRecord } from "@/lib/agents/ui-types";
import { getChannelCommandGuidance } from "@/lib/chat-command-guidance";
import type {
  ChatMessage,
  PendingAssistant,
} from "@/lib/hooks/use-agent-stream";
import { MessageItem } from "./message-item";
import { StreamingMessage } from "./streaming-message";

export type MessageListProps = {
  channel: ChannelRow;
  messages: ChatMessage[];
  pending: PendingAssistant | null;
  agentMap: Map<string, AgentChatRecord>;
  suppressEmptyState?: boolean;
};

export function MessageList({
  channel,
  messages,
  pending,
  agentMap,
  suppressEmptyState = false,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const guidance = getChannelCommandGuidance(channel);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending?.text, pending?.toolEvents.length]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        {messages.length === 0 && !pending && !suppressEmptyState ? (
          <div className="text-sm text-[var(--fg-muted)]">
            {guidance.emptyState}
          </div>
        ) : null}

        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            agent={message.agentId ? agentMap.get(message.agentId) ?? null : null}
          />
        ))}

        {pending ? <StreamingMessage pending={pending} /> : null}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
