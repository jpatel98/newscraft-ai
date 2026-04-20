"use server";

import { revalidatePath } from "next/cache";
import {
  updateWorkspaceAgentConfig,
} from "@/db/queries/agents";
import { requireTenantContext } from "@/lib/server/app-context";
import { tenantAgentPath, tenantBasePath } from "@/lib/server/tenant-path";

export type SaveAgentInput = {
  id: string;
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  description: string;
  userPromptTuning?: string | null;
  preferredSourceUrls?: string[];
  model: string | null;
  enabledTools: string[];
};

export async function saveAgent(input: SaveAgentInput) {
  const { workspace, user } = await requireTenantContext(
    input.orgSlug,
    input.workspaceSlug,
  );

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
  const tenantPath = {
    orgSlug: input.orgSlug,
    workspaceSlug: input.workspaceSlug,
  };
  revalidatePath(tenantAgentPath(tenantPath, input.id));
  revalidatePath(tenantBasePath(tenantPath));
  return { ok: true as const };
}
