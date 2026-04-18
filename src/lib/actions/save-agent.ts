"use server";

import { revalidatePath } from "next/cache";
import { updateAgentConfig } from "@/db/queries/agents";

export type SaveAgentInput = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  enabledTools: string[];
};

export async function saveAgent(input: SaveAgentInput) {
  await updateAgentConfig(input.id, {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    model: input.model,
    enabledTools: input.enabledTools,
  });
  revalidatePath(`/agent/${input.id}`);
  revalidatePath("/");
  return { ok: true as const };
}
