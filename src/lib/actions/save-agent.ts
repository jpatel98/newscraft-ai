"use server";

import { revalidatePath } from "next/cache";
import {
  canEditAgentSettings,
  getWorkspaceAgentRow,
  updateWorkspaceAgentConfig,
} from "@/db/queries/agents";
import { requireWorkspaceAdmin } from "@/lib/server/app-context";

export type SaveAgentInput = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  enabledTools: string[];
};

export async function saveAgent(input: SaveAgentInput) {
  const { workspace, user, membership } = await requireWorkspaceAdmin();
  const current = await getWorkspaceAgentRow(workspace.id, input.id);

  if (current && !canEditAgentSettings(current.policy, membership.role)) {
    throw new Error("This agent is locked from workspace-admin edits.");
  }

  await updateWorkspaceAgentConfig(
    workspace.id,
    input.id,
    {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    model: input.model,
    enabledTools: input.enabledTools,
    },
    user?.id ?? null,
  );
  revalidatePath(`/agent/${input.id}`);
  revalidatePath("/");
  return { ok: true as const };
}
