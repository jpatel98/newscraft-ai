import { db } from "@/db/client";
import { agents as agentsTable } from "@/db/schema";
import { listChannels } from "@/db/queries/channels";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";

const WORKSPACE_ID = "default";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const channels = await listChannels(WORKSPACE_ID);
  const agents = await db.select().from(agentsTable);

  if (channels.length === 0) {
    return <BootstrapNotice />;
  }

  return (
    <WorkspaceShell channels={channels} agents={agents}>
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
