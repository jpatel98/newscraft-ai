import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "paused"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    slugUnique: uniqueIndex("organizations_slug_unique").on(table.slug),
  }),
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    globalRole: text("global_role", { enum: ["user", "admin"] })
      .notNull()
      .default("user"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
  }),
);

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    byOrgSlug: uniqueIndex("workspaces_org_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
  }),
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    revokedAt: integer("revoked_at"),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("auth_sessions_token_hash_unique").on(
      table.tokenHash,
    ),
    byUser: index("auth_sessions_user_created").on(table.userId, table.createdAt),
  }),
);

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    pk: uniqueIndex("org_memberships_org_user").on(
      table.organizationId,
      table.userId,
    ),
  }),
);

export const organizationInvites = sqliteTable(
  "organization_invites",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acceptedAt: integer("accepted_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("org_invites_token_hash_unique").on(
      table.tokenHash,
    ),
  }),
);

export const workspaceMemberships = sqliteTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    pk: uniqueIndex("workspace_memberships_workspace_user").on(
      table.workspaceId,
      table.userId,
    ),
  }),
);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  iconKey: text("icon_key").notNull(),
  capabilities: text("capabilities", { mode: "json" })
    .notNull()
    .$type<{
      streaming: boolean;
      structuredOutput: boolean;
      scheduled: boolean;
    }>(),
  instructions: text("instructions").notNull().default(""),
  model: text("model"),
  enabledTools: text("enabled_tools", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default([]),
  createdAt: integer("created_at").notNull().default(now),
});

export const organizationAgentSettings = sqliteTable(
  "organization_agent_settings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name"),
    description: text("description"),
    instructions: text("instructions"),
    userPromptTuning: text("user_prompt_tuning"),
    preferredSourceUrls: text("preferred_source_urls", { mode: "json" })
      .$type<string[] | null>()
      .default([]),
    model: text("model"),
    enabledTools: text("enabled_tools", { mode: "json" }).$type<string[] | null>(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    policy: text("policy", { mode: "json" })
      .notNull()
      .$type<{
        allowManualRuns: boolean;
        allowScheduledRuns: boolean;
        editableByWorkspaceAdmins: boolean;
      }>(),
    updatedAt: integer("updated_at").notNull().default(now),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    pk: uniqueIndex("org_agent_settings_org_agent").on(
      table.organizationId,
      table.agentId,
    ),
  }),
);

export const workspaceAgentSettings = sqliteTable(
  "workspace_agent_settings",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name"),
    description: text("description"),
    instructions: text("instructions"),
    userPromptTuning: text("user_prompt_tuning"),
    preferredSourceUrls: text("preferred_source_urls", { mode: "json" })
      .$type<string[] | null>()
      .default([]),
    model: text("model"),
    enabledTools: text("enabled_tools", { mode: "json" }).$type<string[] | null>(),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    policy: text("policy", { mode: "json" })
      .notNull()
      .$type<{
        allowManualRuns: boolean;
        allowScheduledRuns: boolean;
        editableByWorkspaceAdmins: boolean;
      }>(),
    updatedAt: integer("updated_at").notNull().default(now),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    pk: uniqueIndex("workspace_agent_settings_workspace_agent").on(
      table.workspaceId,
      table.agentId,
    ),
  }),
);

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["agent_dm", "topic"] }).notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    workspaceSlug: uniqueIndex("channels_workspace_slug").on(
      table.workspaceId,
      table.slug,
    ),
  }),
);

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  agentSessionId: text("agent_session_id"),
  lastResponseId: text("last_response_id"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["user", "assistant", "tool", "system"],
    }).notNull(),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>(),
    renderer: text("renderer"),
    runId: text("run_id"),
    toolName: text("tool_name"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    byChannel: index("messages_channel_created").on(
      table.channelId,
      table.createdAt,
    ),
    byThread: index("messages_thread_created").on(
      table.threadId,
      table.createdAt,
    ),
  }),
);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  runId: text("run_id"),
  lastResponseId: text("last_response_id"),
  status: text("status", {
    enum: ["running", "succeeded", "failed", "cancelled"],
  }).notNull(),
  inputSummary: text("input_summary").notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull().default(now),
  endedAt: integer("ended_at"),
});

export const agentOutputAudits = sqliteTable("agent_output_audits", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  validationStatus: text("validation_status", {
    enum: ["passed", "repaired", "failed"],
  }).notNull(),
  verifierScore: real("verifier_score"),
  issues: text("issues", { mode: "json" }).$type<string[] | null>().default([]),
  latencyMs: integer("latency_ms"),
  toolFailureCount: integer("tool_failure_count").notNull().default(0),
  createdAt: integer("created_at").notNull().default(now),
});

export const newsSources = sqliteTable(
  "news_sources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    label: text("label").notNull(),
    kind: text("kind", { enum: ["rss", "html"] }).notNull(),
    createdAt: integer("created_at").notNull().default(now),
    lastCheckedAt: integer("last_checked_at"),
  },
  (table) => ({
    byWorkspaceUrl: uniqueIndex("news_sources_workspace_url").on(
      table.workspaceId,
      table.url,
    ),
  }),
);

export const digests = sqliteTable(
  "digests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    dateKey: text("date_key").notNull(),
    items: text("items", { mode: "json" }).notNull().$type<unknown[]>(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (table) => ({
    byWorkspaceDate: uniqueIndex("digests_workspace_date").on(
      table.workspaceId,
      table.dateKey,
    ),
  }),
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type OrganizationMembershipRow = typeof organizationMemberships.$inferSelect;
export type OrganizationInviteRow = typeof organizationInvites.$inferSelect;
export type WorkspaceMembershipRow = typeof workspaceMemberships.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type OrganizationAgentSettingsRow =
  typeof organizationAgentSettings.$inferSelect;
export type WorkspaceAgentSettingsRow =
  typeof workspaceAgentSettings.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentOutputAuditRow = typeof agentOutputAudits.$inferSelect;
export type NewsSourceRow = typeof newsSources.$inferSelect;
export type DigestRow = typeof digests.$inferSelect;
