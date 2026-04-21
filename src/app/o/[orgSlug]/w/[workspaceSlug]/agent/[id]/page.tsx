import { notFound, redirect } from "next/navigation";
import {
  AgentConfigEditor,
  type AgentDescriptorForUI,
  type AgentSourceRecord,
} from "@/components/agent/agent-config-editor";
import { getWorkspaceAgentRow } from "@/db/queries/agents";
import { listSources } from "@/db/queries/sources";
import type { AgentConfigRowForUI } from "@/lib/agents/ui-types";
import { getAgent } from "@/lib/agents/catalog";
import { getTenantContext } from "@/lib/server/app-context";
import { isVisibleFrontendAgent } from "@/lib/workspace-channels";

export default async function TenantAgentConfigPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; id: string }>;
}) {
  const { orgSlug, workspaceSlug, id } = await params;
  const context = await getTenantContext(orgSlug, workspaceSlug);
  if (!context) notFound();
  if (!context.workspaceMembership) {
    redirect(`/login?next=${encodeURIComponent(`/o/${orgSlug}/w/${workspaceSlug}/agent/${id}`)}`);
  }

  const descriptor = getAgent(id);
  if (!isVisibleFrontendAgent(id)) {
    return notFound();
  }
  const row = await getWorkspaceAgentRow(context.workspace.id, id);
  if (!descriptor || !row) notFound();

  const sources: AgentSourceRecord[] =
    id === "news-monitor"
      ? (await listSources(context.workspace.id)).map((source) => ({
          id: source.id,
          url: source.url,
          label: source.label,
          kind: source.kind,
        }))
      : [];

  const descriptorForUI: AgentDescriptorForUI = {
    id: descriptor.id,
    defaultName: descriptor.defaultName,
    availableTools: descriptor.availableTools,
    commands: descriptor.commands,
  };
  const rowForUI: AgentConfigRowForUI = {
    id: row.id,
    name: row.name,
    description: row.description,
    model: row.model,
    enabledTools: row.enabledTools ?? [],
    userPromptTuning: row.userPromptTuning ?? null,
    preferredSourceUrls: row.preferredSourceUrls ?? [],
  };

  return (
    <AgentConfigEditor
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      descriptor={descriptorForUI}
      row={rowForUI}
      sources={sources}
    />
  );
}
