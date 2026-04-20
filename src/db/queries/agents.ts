import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  agents,
  organizationAgentSettings,
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
  userPromptTuning: string | null;
  preferredSourceUrls: string[];
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
      userPromptTuning: settings?.userPromptTuning ?? null,
      preferredSourceUrls: settings?.preferredSourceUrls ?? [],
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
  organizationId: string,
  agentId: string,
  fallbackModel?: string | null,
): Promise<AgentRuntimeConfig> {
  const descriptor = getAgentStrict(agentId);
  const [workspaceRow, orgRows] = await Promise.all([
    getWorkspaceAgentRow(workspaceId, agentId),
    db
      .select()
      .from(organizationAgentSettings)
      .where(
        and(
          eq(organizationAgentSettings.organizationId, organizationId),
          eq(organizationAgentSettings.agentId, agentId),
        ),
      ),
  ]);
  const orgRow = orgRows[0];
  const resolvedFallbackModel =
    fallbackModel ?? process.env.OPENAI_MODEL_FAST ?? "gpt-5.4-mini";

  return {
    name: workspaceRow?.name ?? orgRow?.name ?? descriptor.defaultName,
    instructions:
      workspaceRow?.instructions ??
      orgRow?.instructions ??
      descriptor.defaults.instructions,
    userPromptTuning:
      workspaceRow?.userPromptTuning ?? orgRow?.userPromptTuning ?? null,
    preferredSourceUrls:
      workspaceRow?.preferredSourceUrls ?? orgRow?.preferredSourceUrls ?? [],
    model: workspaceRow?.model ?? orgRow?.model ?? resolvedFallbackModel,
    enabledTools:
      workspaceRow?.enabledTools && workspaceRow.enabledTools.length > 0
        ? workspaceRow.enabledTools
        : orgRow?.enabledTools && orgRow.enabledTools.length > 0
          ? orgRow.enabledTools
        : descriptor.defaults.enabledTools,
    policy: workspaceRow?.policy ?? orgRow?.policy ?? DEFAULT_AGENT_POLICY,
    isEnabled: workspaceRow?.isEnabled ?? orgRow?.isEnabled ?? true,
  };
}

export async function updateWorkspaceAgentConfig(
  workspaceId: string,
  agentId: string,
  patch: {
    name?: string;
    description?: string;
    instructions?: string;
    userPromptTuning?: string | null;
    preferredSourceUrls?: string[];
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
    userPromptTuning:
      patch.userPromptTuning !== undefined
        ? patch.userPromptTuning
        : (existing?.userPromptTuning ?? null),
    preferredSourceUrls:
      patch.preferredSourceUrls ?? existing?.preferredSourceUrls ?? [],
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
        userPromptTuning: next.userPromptTuning,
        preferredSourceUrls: next.preferredSourceUrls,
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
        userPromptTuning: null,
        preferredSourceUrls: [],
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

export async function seedOrganizationAgentSettings(
  organizationId: string,
  actor: UserRow | null,
) {
  for (const agent of listAgents()) {
    await db
      .insert(organizationAgentSettings)
      .values({
        organizationId,
        agentId: agent.id,
        name: agent.defaultName,
        description: agent.description,
        instructions: agent.defaults.instructions,
        userPromptTuning: null,
        preferredSourceUrls: [],
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
