"use client";

import type { AgentRow, ChannelRow } from "@/db/schema";
import { AgentList } from "./agent-list";
import { ChannelList } from "./channel-list";

export type SidebarProps = {
  channels: ChannelRow[];
  agents: AgentRow[];
  activeChannelId: string;
  onSelect: (channel: ChannelRow) => void;
};

export function Sidebar({
  channels,
  agents,
  activeChannelId,
  onSelect,
}: SidebarProps) {
  const agentChannels = channels.filter((channel) => channel.kind === "agent_dm");
  const topicChannels = channels.filter((channel) => channel.kind === "topic");

  return (
    <aside className="wkbench-rail flex h-full flex-col gap-6 px-3 py-4">
      <div className="px-2">
        <div className="eyebrow mb-0.5">Workspace</div>
        <div className="text-base font-semibold text-white">NewsCraft</div>
      </div>

      <AgentList
        agentChannels={agentChannels}
        agents={agents}
        activeChannelId={activeChannelId}
        onSelect={onSelect}
      />

      <ChannelList
        topicChannels={topicChannels}
        activeChannelId={activeChannelId}
        onSelect={onSelect}
      />

      <div className="mt-auto px-2 pt-4 text-[0.7rem] text-[var(--fg-onDark-muted)]">
        <p className="leading-relaxed">
          Type <span className="wkbench-kbd">/help</span> to see commands. Use{" "}
          <span className="wkbench-kbd">⌘</span> +{" "}
          <span className="wkbench-kbd">Enter</span> to send.
        </p>
      </div>
    </aside>
  );
}
