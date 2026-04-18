"use client";

import type { ChannelRow } from "@/db/schema";

export function ChatHeader({ channel }: { channel: ChannelRow }) {
  return (
    <header className="flex items-baseline gap-3 border-b border-[var(--border)] px-6 py-3">
      <h1 className="text-base font-semibold text-[var(--fg)]">
        #{channel.name}
      </h1>
      <p className="text-sm text-[var(--fg-muted)] truncate">
        Summon agents with <span className="wkbench-kbd">/expert</span>,{" "}
        <span className="wkbench-kbd">/scout</span>, or @mentions.
      </p>
    </header>
  );
}
