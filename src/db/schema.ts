import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

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
  createdAt: integer("created_at").notNull().default(now),
});

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

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type NewsSourceRow = typeof newsSources.$inferSelect;
export type DigestRow = typeof digests.$inferSelect;
