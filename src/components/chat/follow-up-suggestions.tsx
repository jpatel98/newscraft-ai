"use client";

import type { ChatMessage } from "@/lib/hooks/use-agent-stream";
import type { ExpertiseFinderResult } from "@/lib/types";
import { getCanonicalWorkspaceChannelSlug } from "@/lib/workspace-channels";

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

export function buildFollowUpSuggestions(
  messages: ChatMessage[],
  channelSlug: string,
) {
  const latest = findLatestSearchMessage(messages);
  if (!latest) return [] as FollowUpSuggestion[];

  const canonical = getCanonicalWorkspaceChannelSlug(channelSlug);
  if (canonical === "experts" && latest.renderer === "expert") {
    return buildExpertSuggestions(latest.payload).slice(0, 4);
  }
  if (canonical === "digest" && latest.renderer === "digest") {
    return buildDigestSuggestions().slice(0, 4);
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
      prompt: `/expert For ${topic}, return only the top 3 Canadian interview targets ranked by urgency with public contact details.`,
    },
    {
      id: "expert-outreach",
      label: "Find backup voices",
      prompt: `/expert Find 5 additional backup Canadian experts we can contact for ${topic}.`,
    },
  ]);
}

function buildDigestSuggestions() {

  return uniqueSuggestions([
    {
      id: "digest-latest",
      label: "Run digest now",
      prompt: "/digest",
    },
    {
      id: "digest-scout",
      label: "Run digest for latest news",
      prompt: "/digest",
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
