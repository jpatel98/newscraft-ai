"use client";

import type { AgentRow } from "@/db/schema";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";
import { ExpertResultCard } from "@/components/renderers/expert-result-card";
import { Markdown } from "@/components/renderers/markdown";
import { ScoutBriefCard } from "@/components/renderers/scout-brief-card";
import { DigestCard } from "@/components/renderers/digest-card";
import type { StoryScoutBrief } from "@/lib/agents/story-scout";
import type { DailyDigest } from "@/lib/agents/news-monitor";
import type { ExpertiseFinderResult } from "@/lib/types";

export type MessageItemProps = {
  message: ChatMessage;
  agent: AgentRow | null;
};

export function MessageItem({ message, agent }: MessageItemProps) {
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="wkbench-bubble-user whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    return (
      <div className="flex flex-col gap-2">
        {agent ? (
          <div className="eyebrow text-[var(--fg-subtle)]">{agent.name}</div>
        ) : null}
        <div className="wkbench-bubble-assistant space-y-3">
          {renderAssistantBody(message)}
        </div>
      </div>
    );
  }

  return null;
}

function renderAssistantBody(message: ChatMessage) {
  if (message.renderer === "expert" && message.payload) {
    return (
      <ExpertResultCard
        result={message.payload as ExpertiseFinderResult}
      />
    );
  }
  if (message.renderer === "scout" && message.payload) {
    return <ScoutBriefCard brief={message.payload as StoryScoutBrief} />;
  }
  if (message.renderer === "digest" && message.payload) {
    return <DigestCard digest={message.payload as DailyDigest} />;
  }

  return <Markdown content={message.content} />;
}
