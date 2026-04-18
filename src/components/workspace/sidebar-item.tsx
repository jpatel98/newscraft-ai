"use client";

import { Hash, MessageCircle, Search, Sparkles, Users } from "lucide-react";
import { cn } from "@/lib/utils";

type IconKey = "hash" | "experts" | "scout" | "monitor" | "agent" | string;

const iconMap: Record<string, typeof Hash> = {
  hash: Hash,
  experts: Users,
  scout: Search,
  monitor: Sparkles,
  agent: MessageCircle,
};

export type SidebarItemProps = {
  label: string;
  sublabel?: string;
  iconKey: IconKey;
  active: boolean;
  onClick: () => void;
};

export function SidebarItem({
  label,
  sublabel,
  iconKey,
  active,
  onClick,
}: SidebarItemProps) {
  const Icon = iconMap[iconKey] ?? MessageCircle;

  return (
    <button
      type="button"
      className={cn("wkbench-item text-left w-full")}
      data-active={active}
      onClick={onClick}
      title={sublabel}
    >
      <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}
