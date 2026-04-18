import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, type AgentRow } from "@/db/schema";
import {
  getAgentStrict,
  type AgentRuntimeConfig,
} from "@/lib/agents/registry";

export async function listAgentRows(): Promise<AgentRow[]> {
  return db.select().from(agents);
}

export async function getAgentRow(id: string): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(eq(agents.id, id));
  return rows[0] ?? null;
}

export async function loadAgentRuntimeConfig(
  id: string,
): Promise<AgentRuntimeConfig> {
  const descriptor = getAgentStrict(id);
  const row = await getAgentRow(id);
  const fallbackModel = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
  return {
    name: row?.name ?? descriptor.defaultName,
    instructions: row?.instructions ?? descriptor.defaults.instructions,
    model: row?.model ?? fallbackModel,
    enabledTools:
      row?.enabledTools && row.enabledTools.length > 0
        ? row.enabledTools
        : descriptor.defaults.enabledTools,
  };
}

export async function updateAgentConfig(
  id: string,
  patch: {
    name?: string;
    description?: string;
    instructions?: string;
    model?: string | null;
    enabledTools?: string[];
  },
) {
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.instructions !== undefined) updates.instructions = patch.instructions;
  if (patch.model !== undefined) updates.model = patch.model;
  if (patch.enabledTools !== undefined) updates.enabledTools = patch.enabledTools;

  if (Object.keys(updates).length === 0) return;

  await db.update(agents).set(updates).where(eq(agents.id, id));
}
