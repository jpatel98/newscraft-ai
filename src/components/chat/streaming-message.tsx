"use client";

import type { PendingAssistant } from "@/lib/hooks/use-agent-stream";
import { ExpertResultCard } from "@/components/renderers/expert-result-card";
import { Markdown } from "@/components/renderers/markdown";
import type { ExpertiseFinderResult } from "@/lib/types";
import { ToolStatusPill } from "./tool-status-pill";

export function StreamingMessage({ pending }: { pending: PendingAssistant }) {
  const showFinalCard =
    pending.renderer === "expert" && pending.payload !== null;

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
        {showFinalCard ? (
          <ExpertResultCard
            result={pending.payload as ExpertiseFinderResult}
          />
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
