"use client";

import type { ChannelRow } from "@/db/schema";
import { SidebarItem } from "./sidebar-item";

export type ChannelListProps = {
  topicChannels: ChannelRow[];
  basePath: string;
  pathname: string;
  onNavigate: (href: string) => void;
};

export function ChannelList({
  topicChannels,
  basePath,
  pathname,
  onNavigate,
}: ChannelListProps) {
  if (topicChannels.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <div className="eyebrow px-2 pb-1">Channels</div>
      {topicChannels.map((channel) => {
        const href = `${basePath}/channel/${channel.slug}`;
        return (
          <SidebarItem
            key={channel.id}
            label={`#${channel.name}`}
            iconKey="hash"
            active={pathname === href}
            onClick={() => onNavigate(href)}
          />
        );
      })}
    </section>
  );
}
