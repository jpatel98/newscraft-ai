import { notFound } from "next/navigation";
import {
  AgentConfigEditor,
  type AgentDescriptorForUI,
} from "@/components/agent/agent-config-editor";
import { getAgent } from "@/lib/agents/registry";
import { getAgentRow } from "@/db/queries/agents";

export default async function AgentConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const descriptor = getAgent(id);
  const row = await getAgentRow(id);
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
