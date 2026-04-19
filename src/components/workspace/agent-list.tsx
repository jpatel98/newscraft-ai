"use client";

import type { AgentNavRecord } from "@/lib/agents/ui-types";
import { SidebarItem } from "./sidebar-item";

export type AgentListProps = {
  agents: AgentNavRecord[];
  pathname: string;
  onNavigate: (href: string) => void;
};

export function AgentList({ agents, pathname, onNavigate }: AgentListProps) {
  if (agents.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <div className="eyebrow px-2 pb-1">Agents</div>
      {agents.map((agent) => {
        const href = `/agent/${agent.id}`;
        return (
          <SidebarItem
            key={agent.id}
            label={agent.name}
            sublabel={agent.description}
            iconKey={agent.iconKey}
            active={pathname === href}
            onClick={() => onNavigate(href)}
          />
        );
      })}
    </section>
  );
}
