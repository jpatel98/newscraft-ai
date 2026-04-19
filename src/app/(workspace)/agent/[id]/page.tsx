import { notFound, redirect } from "next/navigation";
import {
  AgentConfigEditor,
  type AgentSourceRecord,
  type AgentDescriptorForUI,
} from "@/components/agent/agent-config-editor";
import { getWorkspaceAgentRow } from "@/db/queries/agents";
import { listSources } from "@/db/queries/sources";
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
    defaults: descriptor.defaults,
  };

  return (
    <AgentConfigEditor
      descriptor={descriptorForUI}
      row={row}
      sources={sources}
    />
  );
}
