import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  agents,
  workspaceAgentSettings,
  type AgentRow,
  type UserRow,
} from "@/db/schema";
import {
  getAgentStrict,
  listAgents,
  type AgentRuntimeConfig,
} from "@/lib/agents/catalog";

export type WorkspaceAgentPolicy = {
  allowManualRuns: boolean;
  allowScheduledRuns: boolean;
  editableByWorkspaceAdmins: boolean;
};

export type WorkspaceAgentRecord = AgentRow & {
  workspaceId: string;
  isEnabled: boolean;
  policy: WorkspaceAgentPolicy;
  updatedAt: number;
  updatedByUserId: string | null;
};

const DEFAULT_AGENT_POLICY: WorkspaceAgentPolicy = {
  allowManualRuns: true,
  allowScheduledRuns: true,
  editableByWorkspaceAdmins: true,
};

export async function listBaseAgentRows(): Promise<AgentRow[]> {
  return db.select().from(agents);
}

export async function getBaseAgentRow(id: string): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(eq(agents.id, id));
  return rows[0] ?? null;
}

export async function listWorkspaceAgentRows(
  workspaceId: string,
): Promise<WorkspaceAgentRecord[]> {
  const [baseRows, settingsRows] = await Promise.all([
    listBaseAgentRows(),
    db
      .select()
      .from(workspaceAgentSettings)
      .where(eq(workspaceAgentSettings.workspaceId, workspaceId)),
  ]);

  const settingsByAgentId = new Map(settingsRows.map((row) => [row.agentId, row]));

  return baseRows.map((baseRow) => {
    const settings = settingsByAgentId.get(baseRow.id);
    return {
      ...baseRow,
      name: settings?.name ?? baseRow.name,
      description: settings?.description ?? baseRow.description,
      instructions: settings?.instructions ?? baseRow.instructions,
      model: settings?.model ?? baseRow.model,
      enabledTools: settings?.enabledTools ?? baseRow.enabledTools,
      workspaceId,
      isEnabled: settings?.isEnabled ?? true,
      policy: settings?.policy ?? DEFAULT_AGENT_POLICY,
      updatedAt: settings?.updatedAt ?? baseRow.createdAt,
      updatedByUserId: settings?.updatedByUserId ?? null,
    };
  });
}

export async function getWorkspaceAgentRow(
  workspaceId: string,
  agentId: string,
): Promise<WorkspaceAgentRecord | null> {
  const rows = await listWorkspaceAgentRows(workspaceId);
  return rows.find((row) => row.id === agentId) ?? null;
}

export async function loadAgentRuntimeConfig(
  workspaceId: string,
  agentId: string,
): Promise<AgentRuntimeConfig> {
  const descriptor = getAgentStrict(agentId);
  const row = await getWorkspaceAgentRow(workspaceId, agentId);
  const fallbackModel = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";

  return {
    name: row?.name ?? descriptor.defaultName,
    instructions: row?.instructions ?? descriptor.defaults.instructions,
    model: row?.model ?? fallbackModel,
    enabledTools:
      row?.enabledTools && row.enabledTools.length > 0
        ? row.enabledTools
        : descriptor.defaults.enabledTools,
    policy: row?.policy ?? DEFAULT_AGENT_POLICY,
    isEnabled: row?.isEnabled ?? true,
  };
}

export async function updateWorkspaceAgentConfig(
  workspaceId: string,
  agentId: string,
  patch: {
    name?: string;
    description?: string;
    instructions?: string;
    model?: string | null;
    enabledTools?: string[];
  },
  actorUserId: string | null,
) {
  const baseAgent = await getBaseAgentRow(agentId);
  if (!baseAgent) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }

  const existingRows = await db
    .select()
    .from(workspaceAgentSettings)
    .where(
      and(
        eq(workspaceAgentSettings.workspaceId, workspaceId),
        eq(workspaceAgentSettings.agentId, agentId),
      ),
    );

  const existing = existingRows[0];
  const next = {
    workspaceId,
    agentId,
    name: patch.name ?? existing?.name ?? baseAgent.name,
    description: patch.description ?? existing?.description ?? baseAgent.description,
    instructions:
      patch.instructions ?? existing?.instructions ?? baseAgent.instructions,
    model:
      patch.model !== undefined ? patch.model : (existing?.model ?? baseAgent.model),
    enabledTools:
      patch.enabledTools ?? existing?.enabledTools ?? baseAgent.enabledTools,
    isEnabled: existing?.isEnabled ?? true,
    policy: existing?.policy ?? DEFAULT_AGENT_POLICY,
    updatedAt: Date.now(),
    updatedByUserId: actorUserId,
  };

  await db
    .insert(workspaceAgentSettings)
    .values(next)
    .onConflictDoUpdate({
      target: [workspaceAgentSettings.workspaceId, workspaceAgentSettings.agentId],
      set: {
        name: next.name,
        description: next.description,
        instructions: next.instructions,
        model: next.model,
        enabledTools: next.enabledTools,
        updatedAt: next.updatedAt,
        updatedByUserId: next.updatedByUserId,
      },
    });
}

export async function seedWorkspaceAgentSettings(
  workspaceId: string,
  actor: UserRow | null,
) {
  for (const agent of listAgents()) {
    await db
      .insert(workspaceAgentSettings)
      .values({
        workspaceId,
        agentId: agent.id,
        name: agent.defaultName,
        description: agent.description,
        instructions: agent.defaults.instructions,
        model: null,
        enabledTools: agent.defaults.enabledTools,
        isEnabled: true,
        policy: DEFAULT_AGENT_POLICY,
        updatedAt: Date.now(),
        updatedByUserId: actor?.id ?? null,
      })
      .onConflictDoNothing();
  }
}

export function canEditAgentSettings(
  policy: WorkspaceAgentPolicy,
  role: "owner" | "admin" | "member" | "viewer",
) {
  if (role === "owner") return true;
  if (role === "admin") return policy.editableByWorkspaceAdmins;
  return false;
}
