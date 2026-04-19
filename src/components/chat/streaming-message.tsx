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
  const shouldHoldStructuredDraft =
    !finalReady &&
    pending.expectedRenderer !== null &&
    pending.expectedRenderer !== "markdown";
  const runningToolCount = pending.toolEvents.filter((evt) => evt.ok === null).length;
  const status =
    runningToolCount > 0
      ? {
          label: "Working through sources",
          detail:
            runningToolCount === 1
              ? "Running 1 action"
              : `Running ${runningToolCount} actions`,
          state: "acting" as const,
        }
      : pending.text
        ? {
            label: "Drafting response",
            detail: "Formatting the current result",
            state: "drafting" as const,
          }
        : {
            label: "Thinking",
            detail: "Planning the next step",
            state: "thinking" as const,
          };

  return (
    <div className="flex flex-col gap-2">
      <div className="wkbench-agent-state" data-state={status.state}>
        <div className="wkbench-agent-state__pulse" aria-hidden />
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--fg)]">{status.label}</div>
          <div className="text-xs text-[var(--fg-muted)]">{status.detail}</div>
        </div>
        <div className="wkbench-agent-state__bars" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      </div>

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
        ) : pending.text && !shouldHoldStructuredDraft ? (
          <div>
            <Markdown content={pending.text} />
            <span className="wkbench-caret" aria-hidden />
          </div>
        ) : (
          <div className="text-sm text-[var(--fg-muted)]">
            Pulling the current result together…
          </div>
        )}
      </div>
    </div>
  );
}
