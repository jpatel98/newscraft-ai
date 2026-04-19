"use client";

import { History } from "lucide-react";
import type { ExpertiseFinderResult } from "@/lib/types";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";

type ExpertHistoryEntry = {
  id: string;
  createdAt: number;
  topic: string;
  storyAngle: string;
  expertNames: string[];
};

export function ExpertHistoryPanel({ messages }: { messages: ChatMessage[] }) {
  const entries = extractExpertHistory(messages);

  return (
    <aside className="absolute inset-y-0 right-0 z-20 w-[min(90vw,340px)] border-l border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-md)] md:static md:w-[320px] md:shadow-none">
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
          <History className="h-4 w-4 text-[var(--fg-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--fg)]">Expert history</h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {entries.length === 0 ? (
            <p className="text-sm text-[var(--fg-muted)]">
              No expert searches yet in this channel.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-elevated)] p-3"
                >
                  <p className="text-xs text-[var(--fg-subtle)]">
                    {formatTimestamp(entry.createdAt)}
                  </p>
                  <p className="mt-1 text-sm font-medium text-[var(--fg)]">
                    {entry.topic}
                  </p>
                  {entry.storyAngle ? (
                    <p className="mt-1 text-xs text-[var(--fg-muted)]">
                      {entry.storyAngle}
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-[var(--fg-muted)]">
                    {entry.expertNames.length > 0
                      ? entry.expertNames.join(", ")
                      : "No expert names returned."}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </aside>
  );
}

export function countExpertHistory(messages: ChatMessage[]) {
  return extractExpertHistory(messages).length;
}

function extractExpertHistory(messages: ChatMessage[]): ExpertHistoryEntry[] {
  const entries = messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.renderer === "expert" &&
        message.payload !== null,
    )
    .map((message) => {
      const parsed = parseExpertiseResult(message.payload);
      if (!parsed) return null;
      return {
        id: message.id,
        createdAt: message.createdAt,
        topic: parsed.topic || "Untitled search",
        storyAngle: parsed.storyAngle || "",
        expertNames: parsed.experts
          .map((expert) => (typeof expert?.name === "string" ? expert.name : ""))
          .filter(Boolean)
          .slice(0, 5),
      } satisfies ExpertHistoryEntry;
    })
    .filter((entry): entry is ExpertHistoryEntry => entry !== null);

  return entries.reverse();
}

function parseExpertiseResult(payload: unknown): ExpertiseFinderResult | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Partial<ExpertiseFinderResult>;
  if (typeof candidate.topic !== "string") return null;
  if (!Array.isArray(candidate.experts)) return null;
  return candidate as ExpertiseFinderResult;
}

function formatTimestamp(value: number) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

