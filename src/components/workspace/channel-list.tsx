"use client";

import type { ChannelRow } from "@/db/schema";
import { SidebarItem } from "./sidebar-item";

export type ChannelListProps = {
  topicChannels: ChannelRow[];
  activeChannelId: string;
  onSelect: (channel: ChannelRow) => void;
};

export function ChannelList({
  topicChannels,
  activeChannelId,
  onSelect,
}: ChannelListProps) {
  if (topicChannels.length === 0) return null;

  return (
    <section className="flex flex-col gap-1">
      <div className="eyebrow px-2 pb-1">Channels</div>
      {topicChannels.map((channel) => (
        <SidebarItem
          key={channel.id}
          label={`#${channel.name}`}
          iconKey="hash"
          active={channel.id === activeChannelId}
          onClick={() => onSelect(channel)}
        />
      ))}
    </section>
  );
}
