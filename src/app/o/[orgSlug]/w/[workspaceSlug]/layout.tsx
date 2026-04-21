import { notFound, redirect } from "next/navigation";
import { listWorkspaceAgentRows } from "@/db/queries/agents";
import { listChannels } from "@/db/queries/channels";
import type { AgentNavRecord } from "@/lib/agents/ui-types";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { getTenantContext } from "@/lib/server/app-context";
import { tenantBasePath } from "@/lib/server/tenant-path";
import {
  isVisibleFrontendAgent,
  projectVisibleChannels,
} from "@/lib/workspace-channels";

export default async function TenantWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const context = await getTenantContext(orgSlug, workspaceSlug);
  if (!context) notFound();
  if (!context.workspaceMembership) {
    redirect(`/login?next=${encodeURIComponent(tenantBasePath({ orgSlug, workspaceSlug }))}`);
  }

  const channels = projectVisibleChannels(
    await listChannels(context.workspace.id),
  );
  const agents = (await listWorkspaceAgentRows(context.workspace.id))
    .filter((agent) => isVisibleFrontendAgent(agent.id))
    .map(
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

  const showAdminTools = context.workspaceMembership.role !== "viewer";

  return (
    <WorkspaceShell
      channels={channels}
      agents={agents}
      showAdminTools={showAdminTools}
      basePath={tenantBasePath({ orgSlug, workspaceSlug })}
    >
      {children}
    </WorkspaceShell>
  );
}

function BootstrapNotice() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-sm text-[var(--fg-muted)]">
        <h1 className="mb-2 text-lg font-semibold text-[var(--fg)]">
          Workspace not seeded
        </h1>
        <p>
          Run <code className="wkbench-kbd">npm run db:migrate</code> then{" "}
          <code className="wkbench-kbd">npm run db:seed</code> to bootstrap the
          workspace and channels.
        </p>
      </div>
    </main>
  );
}
