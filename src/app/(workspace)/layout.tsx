import { redirect } from "next/navigation";
import { listWorkspaceAgentRows } from "@/db/queries/agents";
import { listChannels } from "@/db/queries/channels";
import type { AgentNavRecord } from "@/lib/agents/ui-types";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { getCurrentAppContext } from "@/lib/server/app-context";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { workspace, membership } = await getCurrentAppContext();
  if (!membership) {
    redirect("/login");
  }
  const channels = await listChannels(workspace.id);
  const agents = (await listWorkspaceAgentRows(workspace.id)).map(
    (agent) =>
      ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        iconKey: agent.iconKey,
      }) satisfies AgentNavRecord,
  );

  if (channels.length === 0) {
    return <BootstrapNotice />;
  }

  return (
    <WorkspaceShell
      channels={channels}
      agents={agents}
      showAdminTools
    >
      {children}
    </WorkspaceShell>
  );
}

function BootstrapNotice() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-sm text-[var(--fg-muted)]">
        <h1 className="text-lg font-semibold text-[var(--fg)] mb-2">
          Workspace not seeded
        </h1>
        <p>
          Run <code className="wkbench-kbd">npm run db:migrate</code> then{" "}
          <code className="wkbench-kbd">npm run db:seed</code> to bootstrap the
          default workspace and channels.
        </p>
      </div>
    </main>
  );
}
