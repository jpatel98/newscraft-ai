import { notFound, redirect } from "next/navigation";
import {
  AgentConfigEditor,
  type AgentSourceRecord,
  type AgentDescriptorForUI,
} from "@/components/agent/agent-config-editor";
import { getWorkspaceAgentRow } from "@/db/queries/agents";
import { listSources } from "@/db/queries/sources";
import type { AgentConfigRowForUI } from "@/lib/agents/ui-types";
import { getAgent } from "@/lib/agents/catalog";
import { getCurrentAppContext } from "@/lib/server/app-context";

export default async function AgentConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspace, membership } = await getCurrentAppContext();
  if (!membership) {
    redirect("/login");
  }
  const descriptor = getAgent(id);
  const row = await getWorkspaceAgentRow(workspace.id, id);
  if (!descriptor || !row) notFound();
  const sources: AgentSourceRecord[] =
    id === "news-monitor"
      ? (await listSources(workspace.id)).map((source) => ({
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
      descriptor={descriptorForUI}
      row={rowForUI}
      sources={sources}
    />
  );
}
