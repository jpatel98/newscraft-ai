"use client";

import type { AgentRow, ChannelRow } from "@/db/schema";
import { AgentList } from "./agent-list";
import { ChannelList } from "./channel-list";

export type SidebarProps = {
  channels: ChannelRow[];
  agents: AgentRow[];
  pathname: string;
  onNavigate: (href: string) => void;
};

export function Sidebar({
  channels,
  agents,
  pathname,
  onNavigate,
}: SidebarProps) {
  const topicChannels = channels.filter((channel) => channel.kind === "topic");

  return (
    <aside className="wkbench-rail flex h-full flex-col gap-6 px-3 py-4">
      <div className="px-2">
        <div className="eyebrow mb-0.5">Workspace</div>
        <div className="text-base font-semibold text-white">NewsCraft</div>
      </div>

      <ChannelList
        topicChannels={topicChannels}
        pathname={pathname}
        onNavigate={onNavigate}
      />

      <AgentList
        agents={agents}
        pathname={pathname}
        onNavigate={onNavigate}
      />

      <div className="mt-auto px-2 pt-4 text-[0.7rem] text-[var(--fg-onDark-muted)]">
        <p className="leading-relaxed">
          Type <span className="wkbench-kbd">/help</span> in any channel. Open an
          agent to edit its instructions and tools.
        </p>
      </div>
    </aside>
  );
}
