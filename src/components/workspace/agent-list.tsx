"use client";

import type { AgentRow, ChannelRow } from "@/db/schema";
import { SidebarItem } from "./sidebar-item";

export type AgentListProps = {
  agentChannels: ChannelRow[];
  agents: AgentRow[];
  activeChannelId: string;
  onSelect: (channel: ChannelRow) => void;
};

export function AgentList({
  agentChannels,
  agents,
  activeChannelId,
  onSelect,
}: AgentListProps) {
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));

  return (
    <section className="flex flex-col gap-1">
      <div className="eyebrow px-2 pb-1">Agents</div>
      {agentChannels.map((channel) => {
        const agent = channel.agentId ? agentMap.get(channel.agentId) : null;
        return (
          <SidebarItem
            key={channel.id}
            label={channel.name}
            sublabel={agent?.description}
            iconKey={agent?.iconKey ?? "agent"}
            active={channel.id === activeChannelId}
            onClick={() => onSelect(channel)}
          />
        );
      })}
    </section>
  );
}
