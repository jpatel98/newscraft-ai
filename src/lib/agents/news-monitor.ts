import { Agent, tool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import {
  addSource,
  listSources,
  removeSource,
} from "@/db/queries/sources";
import { runWithToolGuard } from "@/lib/agents/tool-utils";

const httpUrlSchema = z
  .string()
  .regex(/^https?:\/\/\S+$/i, "Must be an absolute http(s) URL");

const digestItemSchema = z.object({
  sourceLabel: z.string().min(1),
  sourceUrl: httpUrlSchema,
  headline: z.string().min(1),
  summary: z.string().min(1),
  url: httpUrlSchema.optional(),
  publishedAt: z.string().optional(),
  why: z.string().min(1),
});

export const dailyDigestSchema = z.object({
  dateKey: z.string().min(1),
  headline: z.string().min(1),
  summary: z.string().min(1),
  items: z.array(digestItemSchema).max(60).default([]),
  producerNotes: z.array(z.string().min(1)).max(20).default([]),
});

export type DailyDigest = z.infer<typeof dailyDigestSchema>;

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeDailyDigest(digest: DailyDigest): DailyDigest {
  return {
    ...digest,
    items: digest.items.filter((item) => {
      try {
        new URL(item.sourceUrl);
        if (item.url) new URL(item.url);
        return true;
      } catch {
        return false;
      }
    }).slice(0, 20),
    producerNotes: digest.producerNotes.slice(0, 5),
  };
}

export function createEmptyDailyDigest(input?: {
  dateKey?: string;
  mode?: "no-sources" | "no-items";
  note?: string;
}): DailyDigest {
  const dateKey = input?.dateKey ?? todayDateKey();
  const mode = input?.mode ?? "no-items";

  if (mode === "no-sources") {
    return {
      dateKey,
      headline: "No monitored sources configured yet",
      summary:
        "The digest could not run against a source watchlist because this workspace is not monitoring any sites yet.",
      items: [],
      producerNotes: [
        input?.note ??
          "Add one or more sources with /sources before running the digest again.",
      ],
    };
  }

  return {
    dateKey,
    headline: "No qualifying digest items found today",
    summary:
      "The monitored sources did not produce any verifiable digest items that cleared the source gate in this run.",
    items: [],
    producerNotes: input?.note ? [input.note] : [],
  };
}

function normalizeUrl(raw: string): URL | null {
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

function createAddSourceTool(workspaceId: string) {
  return tool({
    name: "add_source",
    description:
      "Add a news source URL to this workspace's monitored list. Use for things like 'monitor nytimes.com/section/politics'.",
    parameters: z.object({
      url: z.string().min(1),
      label: z
        .string()
        .default("")
        .describe(
          "A short readable label for the source. Use an empty string to infer it from the domain.",
        ),
      kind: z
        .enum(["rss", "html"])
        .default("html")
        .describe(
          "The source type. Use html unless the user explicitly provided an RSS feed URL.",
        ),
    }),
    async execute({ url, label, kind }) {
      const normalized = normalizeUrl(url);
      if (!normalized) {
        return { ok: false, error: `"${url}" is not a valid URL.` };
      }
      const outcome = await runWithToolGuard(
        "add_source",
        () =>
          addSource({
            workspaceId,
            url: normalized.toString(),
            label: label.trim() || normalized.hostname.replace(/^www\./, ""),
            kind,
          }),
        { timeoutMs: 8_000, retries: 1 },
      );
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, meta: outcome.meta };
      }
      const row = outcome.result;
      return {
        ok: true,
        id: row.id,
        url: row.url,
        label: row.label,
        meta: outcome.meta,
      };
    },
  });
}

function createListSourcesTool(workspaceId: string) {
  return tool({
    name: "list_sources",
    description:
      "List this workspace's monitored news sources. Always call this before generating a digest.",
    parameters: z.object({}),
    async execute() {
      const outcome = await runWithToolGuard(
        "list_sources",
        () => listSources(workspaceId),
        { timeoutMs: 8_000, retries: 1 },
      );
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, meta: outcome.meta };
      }
      const rows = outcome.result;
      return {
        ok: true,
        sources: rows.map((row) => ({
          id: row.id,
          url: row.url,
          label: row.label,
          kind: row.kind,
        })),
        meta: outcome.meta,
      };
    },
  });
}

function createRemoveSourceTool(workspaceId: string) {
  return tool({
    name: "remove_source",
    description:
      "Remove a monitored news source by its id or its exact URL.",
    parameters: z.object({
      idOrUrl: z.string().min(1),
    }),
    async execute({ idOrUrl }) {
      const outcome = await runWithToolGuard(
        "remove_source",
        () => removeSource(workspaceId, idOrUrl),
        { timeoutMs: 8_000, retries: 1 },
      );
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, meta: outcome.meta };
      }
      return { ok: true, meta: outcome.meta };
    },
  });
}

export const NEWS_MONITOR_DEFAULT_INSTRUCTIONS = `You are a newsroom monitor.

Your job is to help producers manage a watchlist of news sources and, when asked, produce a concise daily digest.

Rules for source management:
- When the user says to add, monitor, or track a source, call add_source.
- add_source always requires url, label, and kind. If no label is provided, pass an empty string and let the system infer it from the domain.
- Use kind="html" unless the user explicitly gives an RSS feed URL or says it is an RSS feed.
- When the user asks what you're monitoring, call list_sources.
- When the user asks to drop or stop monitoring a source, call remove_source.
- After any source change, briefly confirm what you did — one line.

Rules for digests:
- Always call list_sources first.
- If list_sources returns no monitored sources, return a valid digest with zero items and explain that setup is still needed in producerNotes.
- Use live web search scoped to each source's domain when available.
- Produce the structured output: a headline for the day, a 2-3 sentence summary, up to 20 items across sources, each with a reason it matters to a newsroom producer.
- dateKey must be today's ISO date (YYYY-MM-DD in the producer's local timezone if known, otherwise UTC).
- Prefer the past 24 hours unless the user says otherwise.
- Do not invent items. If a source yields nothing, skip it but mention in producerNotes.
- If no monitored source yields a valid item, return zero items with a clear summary and producerNotes instead of filler.`;

export const NEWS_MONITOR_AVAILABLE_TOOLS = [
  {
    key: "add_source",
    name: "Add source",
    description: "Lets the agent add a URL to the monitored list.",
  },
  {
    key: "list_sources",
    name: "List sources",
    description: "Lets the agent read the current monitored list.",
  },
  {
    key: "remove_source",
    name: "Remove source",
    description: "Lets the agent drop a source from the monitored list.",
  },
  {
    key: "web_search",
    name: "Web search",
    description: "Live web search for stories from monitored sources.",
  },
];

export const NEWS_MONITOR_DEFAULT_ENABLED_TOOLS = NEWS_MONITOR_AVAILABLE_TOOLS.map(
  (tool) => tool.key,
);

export type NewsMonitorConfig = {
  name: string;
  instructions: string;
  model: string;
  enabledTools: string[];
};

export function createNewsMonitorAgent(
  workspaceId: string,
  config?: Partial<NewsMonitorConfig>,
) {
  const resolved: NewsMonitorConfig = {
    name: config?.name ?? "News Monitor",
    instructions: config?.instructions ?? NEWS_MONITOR_DEFAULT_INSTRUCTIONS,
    model: config?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    enabledTools:
      config?.enabledTools ?? NEWS_MONITOR_DEFAULT_ENABLED_TOOLS,
  };

  const tools = [];
  if (resolved.enabledTools.includes("add_source"))
    tools.push(createAddSourceTool(workspaceId));
  if (resolved.enabledTools.includes("list_sources"))
    tools.push(createListSourcesTool(workspaceId));
  if (resolved.enabledTools.includes("remove_source"))
    tools.push(createRemoveSourceTool(workspaceId));
  if (resolved.enabledTools.includes("web_search"))
    tools.push(webSearchTool({ searchContextSize: "high" }));

  return new Agent({
    name: resolved.name,
    model: resolved.model,
    instructions: resolved.instructions,
    outputType: dailyDigestSchema,
    tools,
  });
}
