"use client";

import type { AgentRow, ChannelRow } from "@/db/schema";

export type ChatHeaderProps = {
  channel: ChannelRow;
  agent: AgentRow | null;
};

export function ChatHeader({ channel, agent }: ChatHeaderProps) {
  const title =
    channel.kind === "topic" ? `#${channel.name}` : channel.name;
  const subtitle =
    channel.kind === "agent_dm"
      ? (agent?.description ?? "")
      : "Topic channel. Commands route to the right agent automatically.";

  return (
    <header className="flex items-baseline gap-3 border-b border-[var(--border)] px-6 py-3">
      <h1 className="text-base font-semibold text-[var(--fg)]">{title}</h1>
      {subtitle ? (
        <p className="text-sm text-[var(--fg-muted)] truncate">{subtitle}</p>
      ) : null}
    </header>
  );
}
