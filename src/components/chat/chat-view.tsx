"use client";

import { useMemo, useState } from "react";
import type { ChannelRow } from "@/db/schema";
import type { AgentChatRecord } from "@/lib/agents/ui-types";
import {
  useAgentStream,
  type ChatMessage,
} from "@/lib/hooks/use-agent-stream";
import { ChatHeader } from "./chat-header";
import {
  countExpertHistory,
  ExpertHistoryPanel,
} from "./expert-history-panel";
import { buildFollowUpSuggestions } from "./follow-up-suggestions";
import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";

export type ChatViewProps = {
  channel: ChannelRow;
  agents: AgentChatRecord[];
  initialMessages: ChatMessage[];
};

export function ChatView({ channel, agents, initialMessages }: ChatViewProps) {
  const { messages, pending, error, streaming, send, cancel } = useAgentStream({
    channelId: channel.id,
    initialMessages,
  });
  const [historyOpen, setHistoryOpen] = useState(false);

  const agentMap = useMemo(
    () => new Map(agents.map((item) => [item.id, item])),
    [agents],
  );
  const historyCount = useMemo(() => countExpertHistory(messages), [messages]);
  const followUpSuggestions = useMemo(
    () => buildFollowUpSuggestions(messages),
    [messages],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        channel={channel}
        historyOpen={historyOpen}
        historyCount={historyCount}
        onToggleHistory={() => setHistoryOpen((value) => !value)}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageList
            channel={channel}
            messages={messages}
            pending={pending}
            agentMap={agentMap}
          />

          {error ? (
            <div className="mx-auto mb-2 w-full max-w-3xl px-6 text-sm text-[var(--danger)]">
              {error}
            </div>
          ) : null}

          <MessageComposer
            channel={channel}
            streaming={streaming}
            suggestions={followUpSuggestions}
            onSend={send}
            onCancel={cancel}
          />
        </div>

        {historyOpen ? <ExpertHistoryPanel messages={messages} /> : null}
      </div>
    </div>
  );
}
