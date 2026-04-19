"use client";

import type { ChannelRow } from "@/db/schema";
import { getChannelCommandGuidance } from "@/lib/chat-command-guidance";

export function ChatHeader({ channel }: { channel: ChannelRow }) {
  const guidance = getChannelCommandGuidance(channel);

  return (
    <header className="flex items-baseline gap-3 border-b border-[var(--border)] px-6 py-3">
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
        ))} or @mentions.
      </p>
    </header>
  );
}
