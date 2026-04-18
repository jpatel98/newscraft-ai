"use client";

import { usePathname, useRouter } from "next/navigation";
import type { AgentRow, ChannelRow } from "@/db/schema";
import { Sidebar } from "./sidebar";

export type WorkspaceShellProps = {
  channels: ChannelRow[];
  agents: AgentRow[];
  children: React.ReactNode;
};

export function WorkspaceShell({
  channels,
  agents,
  children,
}: WorkspaceShellProps) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="grid h-screen grid-cols-[260px_1fr] bg-[var(--bg)] text-[var(--fg)]">
      <Sidebar
        channels={channels}
        agents={agents}
        pathname={pathname}
        onNavigate={(to) => router.push(to)}
      />
      <main className="flex h-full min-h-0 flex-col">{children}</main>
    </div>
  );
}
