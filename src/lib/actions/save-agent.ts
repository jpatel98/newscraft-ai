"use server";

import { revalidatePath } from "next/cache";
import {
  updateWorkspaceAgentConfig,
} from "@/db/queries/agents";
import { requireWorkspaceMembership } from "@/lib/server/app-context";

export type SaveAgentInput = {
  id: string;
  name: string;
  description: string;
  userPromptTuning?: string | null;
  preferredSourceUrls?: string[];
  model: string | null;
  enabledTools: string[];
};

export async function saveAgent(input: SaveAgentInput) {
  const { workspace, user } = await requireWorkspaceMembership();

  await updateWorkspaceAgentConfig(
    workspace.id,
    input.id,
      {
        name: input.name,
        description: input.description,
        userPromptTuning: input.userPromptTuning,
        preferredSourceUrls: input.preferredSourceUrls,
        model: input.model,
        enabledTools: input.enabledTools,
      },
    user?.id ?? null,
  );
  revalidatePath(`/agent/${input.id}`);
  revalidatePath("/");
  return { ok: true as const };
}
