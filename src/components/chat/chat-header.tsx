"use client";

import { History } from "lucide-react";
import type { ChannelRow } from "@/db/schema";
import { getChannelCommandGuidance } from "@/lib/chat-command-guidance";

export function ChatHeader({
  channel,
  historyOpen,
  showHistory,
  historyCount,
  onToggleHistory,
}: {
  channel: ChannelRow;
  historyOpen: boolean;
  showHistory: boolean;
  historyCount: number;
  onToggleHistory: () => void;
}) {
  const guidance = getChannelCommandGuidance(channel);

  return (
    <header className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-3">
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-[var(--fg)]">
          #{channel.name}
        </h1>
        <p className="text-sm text-[var(--fg-muted)] truncate">
          Use{" "}
          {guidance.headerCommands.map((command, index) => (
            <span key={command}>
              <span className="wkbench-kbd">{command}</span>
              {index === guidance.headerCommands.length - 1 ? "" : ", "}
            </span>
          ))}.
        </p>
      </div>
      {showHistory ? (
        <button
          type="button"
          onClick={onToggleHistory}
          className="ml-auto inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[var(--fg-muted)] hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
          aria-expanded={historyOpen}
          aria-label="Toggle expert history"
        >
          <History className="h-4 w-4" />
          {historyCount > 0 ? (
            <span className="wkbench-kbd">{historyCount}</span>
          ) : null}
        </button>
      ) : null}
    </header>
  );
}
