import { Agent, tool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import {
  addSource,
  listSources,
  removeSource,
} from "@/db/queries/sources";

const digestItemSchema = z.object({
  sourceLabel: z.string().min(1),
  sourceUrl: z.string().min(1),
  headline: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().optional(),
  publishedAt: z.string().optional(),
  why: z.string().min(1),
});

export const dailyDigestSchema = z.object({
  dateKey: z.string().min(1),
  headline: z.string().min(1),
  summary: z.string().min(1),
  items: z.array(digestItemSchema).max(20).default([]),
  producerNotes: z.array(z.string().min(1)).max(5).default([]),
});

export type DailyDigest = z.infer<typeof dailyDigestSchema>;

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
      const row = await addSource({
        workspaceId,
        url: normalized.toString(),
        label: label.trim() || normalized.hostname.replace(/^www\./, ""),
        kind,
      });
      return { ok: true, id: row.id, url: row.url, label: row.label };
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
      const rows = await listSources(workspaceId);
      return {
        ok: true,
        sources: rows.map((row) => ({
          id: row.id,
          url: row.url,
          label: row.label,
          kind: row.kind,
        })),
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
      await removeSource(workspaceId, idOrUrl);
      return { ok: true };
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
- Use live web search scoped to each source's domain when available.
- Produce the structured output: a headline for the day, a 2-3 sentence summary, up to 20 items across sources, each with a reason it matters to a newsroom producer.
- dateKey must be today's ISO date (YYYY-MM-DD in the producer's local timezone if known, otherwise UTC).
- Prefer the past 24 hours unless the user says otherwise.
- Do not invent items. If a source yields nothing, skip it but mention in producerNotes.`;

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
