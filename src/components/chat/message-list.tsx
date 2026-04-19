"use client";

import { useEffect, useRef } from "react";
import type { WorkspaceAgentRecord } from "@/db/queries/agents";
import type {
  ChatMessage,
  PendingAssistant,
} from "@/lib/hooks/use-agent-stream";
import { MessageItem } from "./message-item";
import { StreamingMessage } from "./streaming-message";

export type MessageListProps = {
  messages: ChatMessage[];
  pending: PendingAssistant | null;
  agentMap: Map<string, WorkspaceAgentRecord>;
};

export function MessageList({ messages, pending, agentMap }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending?.text, pending?.toolEvents.length]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        {messages.length === 0 && !pending ? (
          <div className="text-sm text-[var(--fg-muted)]">
            No messages yet. Try{" "}
            <span className="wkbench-kbd">/expert</span> plus a story brief, or
            type <span className="wkbench-kbd">/help</span>.
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
