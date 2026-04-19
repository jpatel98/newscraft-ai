"use client";

import type { DailyDigest } from "@/lib/agents/news-monitor";
import type { StoryScoutBrief } from "@/lib/agents/story-scout";
import type { ChatMessage } from "@/lib/hooks/use-agent-stream";
import type { ExpertiseFinderResult } from "@/lib/types";

export type FollowUpSuggestion = {
  id: string;
  label: string;
  prompt: string;
};

export type FollowUpSuggestionsProps = {
  suggestions: FollowUpSuggestion[];
  disabled?: boolean;
  onSelect: (prompt: string) => void;
};

export function FollowUpSuggestions({
  suggestions,
  disabled = false,
  onSelect,
}: FollowUpSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2.5">
      <div className="pb-2 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-[var(--fg-subtle)]">
        Follow-up ideas
      </div>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            className="rounded-full border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-left text-xs text-[var(--fg)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onSelect(suggestion.prompt)}
            disabled={disabled}
            title={suggestion.prompt}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function buildFollowUpSuggestions(messages: ChatMessage[]) {
  const latest = findLatestSearchMessage(messages);
  if (!latest) return [] as FollowUpSuggestion[];

  if (latest.renderer === "expert") {
    return buildExpertSuggestions(latest.payload).slice(0, 4);
  }
  if (latest.renderer === "scout") {
    return buildScoutSuggestions(latest.payload).slice(0, 4);
  }
  if (latest.renderer === "digest") {
    return buildDigestSuggestions(latest.payload).slice(0, 4);
  }

  return [] as FollowUpSuggestion[];
}

function findLatestSearchMessage(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;

    if (
      message.payload &&
      (message.renderer === "expert" ||
        message.renderer === "scout" ||
        message.renderer === "digest")
    ) {
      return message;
    }

    // Only show follow-up chips when the latest assistant answer is a search-style result.
    return null;
  }

  return null;
}

function buildExpertSuggestions(payload: unknown) {
  const result = payload as Partial<ExpertiseFinderResult>;
  const topic = cleanText(result.topic) || "this topic";
  const firstExpert =
    Array.isArray(result.experts) && result.experts[0]?.name
      ? cleanText(result.experts[0].name) || "the top expert"
      : "the top expert";

  return uniqueSuggestions([
    {
      id: "expert-more-canadian",
      label: "Find more Canadian voices",
      prompt: `/expert Find 5 additional Canadian experts we can quote on ${topic}.`,
    },
    {
      id: "expert-regional",
      label: "Narrow by region",
      prompt: `/expert Narrow this to Toronto and Ottawa experts on ${topic}.`,
    },
    {
      id: "expert-prioritize",
      label: "Prioritize top 3",
      prompt: `From this list, rank the top 3 interview targets for ${topic} and explain the order.`,
    },
    {
      id: "expert-outreach",
      label: "Draft outreach message",
      prompt: `Draft a concise outreach email for ${firstExpert} about ${topic}.`,
    },
  ]);
}

function buildScoutSuggestions(payload: unknown) {
  const brief = payload as Partial<StoryScoutBrief>;
  const topic = cleanText(brief.topic) || "this story";
  const firstAngle =
    Array.isArray(brief.angles) && brief.angles[0]?.title
      ? cleanText(brief.angles[0].title) || "the top angle"
      : "the top angle";

  return uniqueSuggestions([
    {
      id: "scout-experts",
      label: "Find experts for this story",
      prompt: `/expert Find 5 Canadian experts we can quote on ${topic}.`,
    },
    {
      id: "scout-angle-plan",
      label: "Turn angle into plan",
      prompt: `Turn "${firstAngle}" into a same-day reporting plan with concrete next steps.`,
    },
    {
      id: "scout-sharper-questions",
      label: "Generate sharper questions",
      prompt: `Write 8 sharper follow-up interview questions for ${topic}.`,
    },
    {
      id: "scout-fact-check",
      label: "Fact-check checklist",
      prompt: `Create a pre-publication fact-check checklist for this ${topic} story.`,
    },
  ]);
}

function buildDigestSuggestions(payload: unknown) {
  const digest = payload as Partial<DailyDigest>;
  const firstHeadline =
    Array.isArray(digest.items) && digest.items[0]?.headline
      ? cleanText(digest.items[0].headline) || "the top digest item"
      : "the top digest item";

  return uniqueSuggestions([
    {
      id: "digest-priority",
      label: "Prioritize rundown",
      prompt:
        "Pick the top 2 items for today's rundown and explain why they matter most right now.",
    },
    {
      id: "digest-scout",
      label: "Build story brief",
      prompt: `/scout Build a story brief from this item: ${firstHeadline}.`,
    },
    {
      id: "digest-experts",
      label: "Find expert voices",
      prompt: `/expert Find Canadian experts to quote on this item: ${firstHeadline}.`,
    },
    {
      id: "digest-producer-note",
      label: "Draft producer note",
      prompt:
        "Draft a tight producer note and segment setup for an on-air hit based on this digest.",
    },
  ]);
}

function uniqueSuggestions(items: FollowUpSuggestion[]) {
  const seen = new Set<string>();
  const deduped: FollowUpSuggestion[] = [];

  for (const item of items) {
    const key = item.prompt.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function cleanText(value: string | undefined | null) {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}
