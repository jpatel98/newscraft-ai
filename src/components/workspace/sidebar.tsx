"use client";

import type { ChannelRow } from "@/db/schema";
import type { AgentNavRecord } from "@/lib/agents/ui-types";
import { AgentList } from "./agent-list";
import { ChannelList } from "./channel-list";

export type SidebarProps = {
  channels: ChannelRow[];
  agents: AgentNavRecord[];
  showAdminTools: boolean;
  basePath: string;
  pathname: string;
  onNavigate: (href: string) => void;
};

export function Sidebar({
  channels,
  agents,
  showAdminTools,
  basePath,
  pathname,
  onNavigate,
}: SidebarProps) {
  const topicChannels = channels.filter((channel) => channel.kind === "topic");

  return (
    <aside className="wkbench-rail flex h-full flex-col gap-6 px-3 py-4">
      <div className="px-2 pt-1">
        <div className="text-base font-semibold text-white">NewsCraft AI</div>
      </div>

      <ChannelList
        topicChannels={topicChannels}
        basePath={basePath}
        pathname={pathname}
        onNavigate={onNavigate}
      />

      {showAdminTools ? (
        <AgentList
          agents={agents}
          basePath={basePath}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      ) : null}

      <div className="mt-auto px-2 pt-4 text-[0.7rem] text-[var(--fg-onDark-muted)]">
        <p className="leading-relaxed">Slash commands drive this workspace.</p>
        <a
          href={`${basePath}/logout`}
          className="mt-3 inline-flex text-[0.75rem] text-[var(--fg-onDark)] underline underline-offset-2"
        >
          Sign out
        </a>
      </div>
    </aside>
  );
}
