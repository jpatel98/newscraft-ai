"use client";

import { X } from "lucide-react";
import type { ChannelRow } from "@/db/schema";
import {
  getCanonicalWorkspaceChannelSlug,
  type WorkspaceChannelSlug,
} from "@/lib/workspace-channels";

type OnboardingPrompt = {
  id: string;
  label: string;
  prompt: string;
};

type WorkspaceOnboardingContent = {
  title: string;
  description: string;
  prompts: OnboardingPrompt[];
};

const ONBOARDING_CONTENT: Record<WorkspaceChannelSlug, WorkspaceOnboardingContent> = {
  experts: {
    title: "Find strong voices fast",
    description:
      "This channel helps you build expert leads with a single command.",
    prompts: [
      {
        id: "experts-first",
        label: "Find 5 Canadian experts on housing policy",
        prompt:
          "/expert Find 5 Canadian experts we can quote about housing policy in major cities.",
      },
      {
        id: "experts-second",
        label: "Scope by region",
        prompt:
          "/expert List 3 Toronto-area experts on transit policy with public contact details.",
      },
      {
        id: "experts-third",
        label: "See command shortcuts",
        prompt: "/help",
      },
    ],
  },
  digest: {
    title: "Turn the latest coverage into a briefing",
    description:
      "This channel helps you pull a concise summary from newsroom sources.",
    prompts: [
      {
        id: "digest-first",
        label: "Generate today's digest",
        prompt: "/digest",
      },
      {
        id: "digest-second",
        label: "Refresh another digest",
        prompt: "Summarize the latest housing coverage in one paragraph.",
      },
      {
        id: "digest-third",
        label: "See command shortcuts",
        prompt: "/help",
      },
    ],
  },
};

const DEFAULT_CONTENT: WorkspaceOnboardingContent = {
  title: "Use channel commands to get started",
  description:
    "This workspace supports slash-command prompts for each channel.",
  prompts: [
    { id: "default-first", label: "Show what I can run", prompt: "/help" },
  ],
};

export function getOnboardingContentForChannelSlug(
  channelSlug: string,
): WorkspaceOnboardingContent {
  const canonical = getCanonicalWorkspaceChannelSlug(channelSlug);
  return canonical ? ONBOARDING_CONTENT[canonical] : DEFAULT_CONTENT;
}

export type WorkspaceOnboardingProps = {
  channel: ChannelRow;
  onSend: (prompt: string) => void;
  onDismiss: () => void;
  disabled?: boolean;
  isVisible: boolean;
};

export function WorkspaceOnboarding({
  channel,
  onSend,
  onDismiss,
  disabled = false,
  isVisible,
}: WorkspaceOnboardingProps) {
  const content = getOnboardingContentForChannelSlug(channel.slug);

  if (!isVisible) return null;

  return (
    <section className="mx-auto w-full max-w-3xl px-6 py-3">
      <div className="rounded-[var(--radius-md)] border border-[var(--accent-link-soft)] bg-[var(--bg-elevated)] px-4 py-3">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--fg)]">
              {content.title}
            </h2>
            <p className="mt-1 text-sm text-[var(--fg-muted)]">
              {content.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
            aria-label="Hide onboarding"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {content.prompts.map((item) => (
            <button
              key={item.id}
            type="button"
            onClick={() => {
              if (disabled) return;
                onSend(item.prompt);
              }}
              className="rounded-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-left text-xs text-[var(--fg)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
              title={item.prompt}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
