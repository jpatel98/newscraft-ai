"use client";

import { useCallback, useMemo, useState } from "react";
import type { ChannelRow } from "@/db/schema";
import type { AgentChatRecord } from "@/lib/agents/ui-types";
import { isExpertHistoryChannel } from "@/lib/workspace-channels";
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
import { WorkspaceOnboarding } from "@/components/onboarding/workspace-onboarding";

export type ChatViewProps = {
  channel: ChannelRow;
  agents: AgentChatRecord[];
  initialMessages: ChatMessage[];
  orgSlug: string;
  workspaceSlug: string;
  onboardingStorageKey?: string;
};

export function ChatView({
  channel,
  agents,
  initialMessages,
  orgSlug,
  workspaceSlug,
  onboardingStorageKey: onboardingStorageKeyProp,
}: ChatViewProps) {
  const { messages, pending, error, streaming, send, cancel } = useAgentStream({
    channelId: channel.id,
    initialMessages,
    orgSlug,
    workspaceSlug,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const showHistoryPanel = isExpertHistoryChannel(channel.slug);
  const historyCount = useMemo(
    () => (showHistoryPanel ? countExpertHistory(messages) : 0),
    [messages, showHistoryPanel],
  );

  const agentMap = useMemo(
    () => new Map(agents.map((item) => [item.id, item])),
    [agents],
  );
  const followUpSuggestions = useMemo(
    () => buildFollowUpSuggestions(messages, channel.slug),
    [messages, channel.slug],
  );
  const onboardingStorageKey =
    onboardingStorageKeyProp ??
    `newscraft:onboarding/${orgSlug}/${workspaceSlug}/${channel.slug}`;
  const [wasDismissedInSession, setWasDismissedInSession] = useState(false);
  const isOnboardingHiddenFromStorage = useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem(onboardingStorageKey) === "1";
    } catch {
      return false;
    }
  }, [onboardingStorageKey]);
  const isOnboardingHidden =
    wasDismissedInSession || isOnboardingHiddenFromStorage;

  const dismissOnboarding = useCallback(() => {
    try {
      localStorage.setItem(onboardingStorageKey, "1");
    } catch {
      // no-op if localStorage is unavailable
    }
    setWasDismissedInSession(true);
  }, [onboardingStorageKey]);
  const sendOnboardingPrompt = useCallback(
    (prompt: string) => {
      dismissOnboarding();
      send(prompt);
    },
    [dismissOnboarding, send],
  );
  const canShowOnboarding =
    messages.length === 0 && !pending && !isOnboardingHidden;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        channel={channel}
        historyOpen={historyOpen}
        showHistory={showHistoryPanel}
        historyCount={historyCount}
        onToggleHistory={() => setHistoryOpen((value) => !value)}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceOnboarding
            channel={channel}
            onSend={sendOnboardingPrompt}
            onDismiss={dismissOnboarding}
            disabled={streaming || !!pending}
            isVisible={canShowOnboarding}
          />
          <MessageList
            channel={channel}
            messages={messages}
            pending={pending}
            agentMap={agentMap}
            suppressEmptyState={canShowOnboarding}
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

        {showHistoryPanel && historyOpen ? (
          <ExpertHistoryPanel messages={messages} />
        ) : null}
      </div>
    </div>
  );
}
