"use client";

import type { ChannelRow } from "@/db/schema";
import type { WorkspaceAgentRecord } from "@/db/queries/agents";
import { AgentList } from "./agent-list";
import { ChannelList } from "./channel-list";

export type SidebarProps = {
  channels: ChannelRow[];
  agents: WorkspaceAgentRecord[];
  showAdminTools: boolean;
  pathname: string;
  onNavigate: (href: string) => void;
};

export function Sidebar({
  channels,
  agents,
  showAdminTools,
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

      {showAdminTools ? (
        <AgentList
          agents={agents}
          pathname={pathname}
          onNavigate={onNavigate}
        />
      ) : null}

      <div className="mt-auto px-2 pt-4 text-[0.7rem] text-[var(--fg-onDark-muted)]">
        <p className="leading-relaxed">
          Type <span className="wkbench-kbd">/help</span> in any channel to see the available newsroom actions.
        </p>
        <a
          href="/auth/logout"
          className="mt-3 inline-flex text-[0.75rem] text-[var(--fg-onDark)] underline underline-offset-2"
        >
          Sign out
        </a>
      </div>
    </aside>
  );
}
