"use client";

import type { PendingAssistant } from "@/lib/hooks/use-agent-stream";
import { ExpertResultCard } from "@/components/renderers/expert-result-card";
import { Markdown } from "@/components/renderers/markdown";
import { ScoutBriefCard } from "@/components/renderers/scout-brief-card";
import { DigestCard } from "@/components/renderers/digest-card";
import type { StoryScoutBrief } from "@/lib/agents/story-scout";
import type { DailyDigest } from "@/lib/agents/news-monitor";
import type { ExpertiseFinderResult } from "@/lib/types";
import { ToolStatusPill } from "./tool-status-pill";

export function StreamingMessage({ pending }: { pending: PendingAssistant }) {
  const finalReady = pending.payload !== null && pending.renderer !== null;

  return (
    <div className="flex flex-col gap-2">
      {pending.toolEvents.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {pending.toolEvents.map((evt) => (
            <ToolStatusPill key={evt.id} event={evt} />
          ))}
        </div>
      ) : null}

      <div className="wkbench-bubble-assistant space-y-3">
        {finalReady && pending.renderer === "expert" ? (
          <ExpertResultCard
            result={pending.payload as ExpertiseFinderResult}
          />
        ) : finalReady && pending.renderer === "scout" ? (
          <ScoutBriefCard brief={pending.payload as StoryScoutBrief} />
        ) : finalReady && pending.renderer === "digest" ? (
          <DigestCard digest={pending.payload as DailyDigest} />
        ) : pending.text ? (
          <div>
            <Markdown content={pending.text} />
            <span className="wkbench-caret" aria-hidden />
          </div>
        ) : (
          <div className="text-sm text-[var(--fg-muted)]">Thinking…</div>
        )}
      </div>
    </div>
  );
}
