import { notFound } from "next/navigation";
import {
  AgentConfigEditor,
  type AgentDescriptorForUI,
} from "@/components/agent/agent-config-editor";
import { getWorkspaceAgentRow } from "@/db/queries/agents";
import { getAgent } from "@/lib/agents/registry";
import { getCurrentAppContext } from "@/lib/server/app-context";

export default async function AgentConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspace } = await getCurrentAppContext();
  const descriptor = getAgent(id);
  const row = await getWorkspaceAgentRow(workspace.id, id);
  if (!descriptor || !row) notFound();

  const descriptorForUI: AgentDescriptorForUI = {
    id: descriptor.id,
    defaultName: descriptor.defaultName,
    availableTools: descriptor.availableTools,
    commands: descriptor.commands,
    defaults: descriptor.defaults,
  };

  return <AgentConfigEditor descriptor={descriptorForUI} row={row} />;
}
