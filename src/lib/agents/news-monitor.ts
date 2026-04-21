import { Agent, tool, webSearchTool } from "@openai/agents";
import { load } from "cheerio";
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
  const normalizedItems = digest.items
    .map((item) => {
      try {
        const sourceUrl = new URL(item.sourceUrl).toString();
        if (!item.url) return null;

        const itemUrl = new URL(item.url).toString();
        if (itemUrl === sourceUrl) return null;

        return {
          ...item,
          sourceUrl,
          url: itemUrl,
          publishedAt:
            item.publishedAt && item.publishedAt.trim()
              ? item.publishedAt.trim()
              : undefined,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 20);

  if (normalizedItems.length < 1) {
    return createEmptyDailyDigest({ dateKey: digest.dateKey, mode: "no-items" });
  }

  return {
    ...digest,
    items: normalizedItems,
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
      "This run did not confirm any digest items from the monitored sources.",
    items: [],
    producerNotes: [
      input?.note ??
        "Try again later or add sources that expose stable article links for item-level confirmation.",
    ],
  };
}

function normalizeUrl(raw: string): URL | null {
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

function stripWww(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isSameDomainOrSubdomain(candidateUrl: string, sourceUrl: string) {
  try {
    const candidateHost = stripWww(new URL(candidateUrl).hostname);
    const sourceHost = stripWww(new URL(sourceUrl).hostname);
    return (
      candidateHost === sourceHost || candidateHost.endsWith(`.${sourceHost}`)
    );
  } catch {
    return false;
  }
}

function getAbsoluteUrl(rawHref: string, baseUrl: string) {
  try {
    return new URL(rawHref, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

type SourceArticleCandidate = {
  headline: string;
  url: string;
  publishedAt: string | undefined;
};

type ScoredSourceArticleCandidate = SourceArticleCandidate & {
  score: number;
};

function looksLikeArticleUrl(url: string) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname === "/" || pathname.length < 8) return false;

    const blockedSegments = [
      "/feed",
      "/feeds",
      "/rss",
      "/tag/",
      "/tags/",
      "/topic/",
      "/topics/",
      "/section/",
      "/sections/",
      "/category/",
      "/categories/",
      "/search",
      "/video",
      "/videos",
      "/live",
      "/newsletter",
      "/author/",
      "/authors/",
      "/profile/",
      "/profiles/",
      "/about",
      "/contact",
      "/login",
      "/signin",
      "/account",
    ];

    if (blockedSegments.some((segment) => pathname.includes(segment))) {
      return false;
    }

    return (
      pathname.split("/").filter(Boolean).length >= 2 ||
      /\/\d{4}\/\d{2}\//.test(pathname) ||
      /-[a-z0-9]+(?:-[a-z0-9]+)+/.test(pathname)
    );
  } catch {
    return false;
  }
}

function scoreArticleLink(input: {
  url: string;
  label: string;
  withinArticle: boolean;
  withinHeadline: boolean;
}) {
  const pathname = new URL(input.url).pathname.toLowerCase();
  let score = 0;

  if (input.withinArticle) score += 4;
  if (input.withinHeadline) score += 4;
  if (looksLikeArticleUrl(input.url)) score += 4;
  if (input.label.length >= 24) score += 2;
  if (pathname.split("/").filter(Boolean).length >= 3) score += 1;
  if (/\d{4}\/\d{2}/.test(pathname)) score += 2;

  if (/opinion|editorial|newsletter|podcast|video/.test(pathname)) {
    score -= 2;
  }

  return score;
}

function extractCandidateArticlesFromHtml(input: {
  html: string;
  sourceUrl: string;
  limit: number;
}) {
  const $ = load(input.html);
  $("script, style, noscript, iframe, svg, nav, footer, form").remove();

  const seen = new Set<string>();
  const candidates = $("a[href]")
    .toArray()
    .flatMap((anchor) => {
      const href = $(anchor).attr("href");
      if (!href) return [];

      const absolute = getAbsoluteUrl(href, input.sourceUrl);
      if (!absolute) return [];
      if (!isSameDomainOrSubdomain(absolute, input.sourceUrl)) return [];
      if (seen.has(absolute)) return [];

      const label = normalizeWhitespace($(anchor).text());
      if (label.length < 16) return [];

      const withinArticle = $(anchor).parents("article").length > 0;
      const withinHeadline = $(anchor).parents("h1, h2, h3, h4").length > 0;
      const score = scoreArticleLink({
        url: absolute,
        label,
        withinArticle,
        withinHeadline,
      });
      if (score < 4) return [];

      seen.add(absolute);

      const articleParent = $(anchor).closest("article");
      const timeText = normalizeWhitespace(
        articleParent.find("time").first().attr("datetime") ||
          articleParent.find("time").first().text(),
      );

      return [
        {
          headline: label,
          url: absolute,
          publishedAt: timeText || undefined,
          score,
        } satisfies ScoredSourceArticleCandidate,
      ];
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit);

  return candidates.map((candidate) => ({
    headline: candidate.headline,
    url: candidate.url,
    publishedAt: candidate.publishedAt,
  }));
}

function extractCandidateArticlesFromFeed(input: {
  xml: string;
  sourceUrl: string;
  limit: number;
}) {
  const $ = load(input.xml, { xmlMode: true });

  return $("item, entry")
    .toArray()
    .flatMap((entry) => {
      const title = normalizeWhitespace($(entry).find("title").first().text());
      const linkElement = $(entry).find("link").first();
      const link =
        normalizeWhitespace(linkElement.text()) ||
        normalizeWhitespace(linkElement.attr("href") || "");
      const publishedAt = normalizeWhitespace(
        $(entry).find("pubDate, published, updated").first().text(),
      );

      if (!title || !link) return [];

      const absolute = getAbsoluteUrl(link, input.sourceUrl);
      if (!absolute) return [];
      if (!isSameDomainOrSubdomain(absolute, input.sourceUrl)) return [];

      return [
        {
          headline: title,
          url: absolute,
          publishedAt: publishedAt || undefined,
        } satisfies SourceArticleCandidate,
      ];
    })
    .slice(0, input.limit);
}

function extractArticleDetails(html: string, url: string) {
  const $ = load(html);
  $("script, style, noscript, iframe, svg, nav, footer, form").remove();

  const title = normalizeWhitespace(
    $('meta[property="og:title"]').attr("content") ||
      $("article h1").first().text() ||
      $("main h1").first().text() ||
      $("h1").first().text() ||
      $("title").first().text(),
  );

  const publishedAt = normalizeWhitespace(
    $('meta[property="article:published_time"]').attr("content") ||
      $('meta[name="parsely-pub-date"]').attr("content") ||
      $('meta[name="pubdate"]').attr("content") ||
      $('meta[itemprop="datePublished"]').attr("content") ||
      $("time[datetime]").first().attr("datetime") ||
      $("time").first().text(),
  );

  const bodyText = normalizeWhitespace(
    $("article").first().text() ||
      $("main").first().text() ||
      $("body").text(),
  );

  return {
    url,
    title: title || url,
    publishedAt: publishedAt || undefined,
    excerpt: bodyText.slice(0, 5000),
  };
}

function createInspectSourceTool() {
  return tool({
    name: "inspect_source_page",
    description:
      "Fetch a monitored source and return candidate article links. For HTML sources, use this to inspect the homepage or section page. For RSS sources, use this to read feed entries.",
    parameters: z.object({
      url: z.string().min(1),
      kind: z.enum(["html", "rss"]).default("html"),
      limit: z.number().int().min(1).max(12).default(8),
    }),
    async execute({ url, kind, limit }) {
      const normalized = normalizeUrl(url);
      if (!normalized) {
        return { ok: false, error: `"${url}" is not a valid URL.` };
      }

      const outcome = await runWithToolGuard(
        "inspect_source_page",
        async () => {
          const response = await fetch(normalized.toString(), {
            headers: { "User-Agent": "NewsCraftAI/0.1 news-monitor" },
            signal: AbortSignal.timeout(15_000),
          });
          const raw = await response.text();

          const articles =
            kind === "rss"
              ? extractCandidateArticlesFromFeed({
                  xml: raw,
                  sourceUrl: normalized.toString(),
                  limit,
                })
              : extractCandidateArticlesFromHtml({
                  html: raw,
                  sourceUrl: normalized.toString(),
                  limit,
                });

          return {
            url: normalized.toString(),
            kind,
            articles,
          };
        },
        { timeoutMs: 15_000, retries: 1 },
      );

      if (!outcome.ok) {
        return { ok: false, error: outcome.error, meta: outcome.meta };
      }

      return {
        ok: true,
        ...outcome.result,
        meta: outcome.meta,
      };
    },
  });
}

function createInspectArticleTool() {
  return tool({
    name: "inspect_article_page",
    description:
      "Fetch a candidate article page and extract its title, article text, and published date when present. Use this before adding a digest item.",
    parameters: z.object({
      sourceUrl: z.string().min(1),
      url: z.string().min(1),
    }),
    async execute({ sourceUrl, url }) {
      const normalizedSource = normalizeUrl(sourceUrl);
      const normalizedArticle = normalizeUrl(url);

      if (!normalizedSource) {
        return { ok: false, error: `"${sourceUrl}" is not a valid source URL.` };
      }
      if (!normalizedArticle) {
        return { ok: false, error: `"${url}" is not a valid article URL.` };
      }
      if (
        !isSameDomainOrSubdomain(
          normalizedArticle.toString(),
          normalizedSource.toString(),
        )
      ) {
        return {
          ok: false,
          error: `Article URL ${normalizedArticle.toString()} is outside the monitored source domain.`,
        };
      }

      const outcome = await runWithToolGuard(
        "inspect_article_page",
        async () => {
          const response = await fetch(normalizedArticle.toString(), {
            headers: { "User-Agent": "NewsCraftAI/0.1 news-monitor" },
            signal: AbortSignal.timeout(15_000),
          });
          const html = await response.text();
          return extractArticleDetails(html, normalizedArticle.toString());
        },
        { timeoutMs: 15_000, retries: 1 },
      );

      if (!outcome.ok) {
        return { ok: false, error: outcome.error, meta: outcome.meta };
      }

      return {
        ok: true,
        ...outcome.result,
        meta: outcome.meta,
      };
    },
  });
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

Your job is to monitor a watchlist of news sources and produce a concise intelligence digest.

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
- For each monitored source, call inspect_source_page to collect candidate article links from the homepage, section page, or feed.
- Before you add any digest item, call inspect_article_page for that item's URL and base your claim on the inspected article text.
- Use live web search only as a fallback when source inspection is thin, and still confirm the final item with inspect_article_page before including it.
- Produce the structured output: a headline for the day, a 2-3 sentence summary, up to 20 items across sources, each with a clear intelligence signal grounded in the source text.
- Every item must include a stable item-level URL in \`url\`. Do not use a homepage, section page, or RSS feed URL as the item URL.
- Use \`sourceUrl\` for the monitored source page/feed and \`url\` for the exact story or post permalink.
- Only include \`publishedAt\` when the linked item explicitly shows that date. Otherwise leave it blank.
- If you cannot confirm a stable item URL for a claim, skip that item.
- Top-level headline and summary must describe only the confirmed items that remain in \`items\`.
- Do not describe homepage visibility, scraping limits, extraction failures, or tool problems as factual digest findings.
- dateKey must be today's ISO date (YYYY-MM-DD in the user's local timezone if known, otherwise UTC).
- Prefer the past 24 hours unless the user says otherwise.
- Do not invent items. If a source yields nothing, skip it but mention the gap in producerNotes.
- Use producerNotes only for neutral intelligence notes or sourcing gaps. Do not give advice, strategy, assignments, or journalist-style framing.
- Keep the tone factual, concise, and analytical. You are not the journalist. You are an intelligence layer.
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
    key: "inspect_source_page",
    name: "Inspect source",
    description: "Reads a monitored homepage, section page, or feed and returns candidate article links.",
  },
  {
    key: "inspect_article_page",
    name: "Inspect article",
    description: "Reads an article page and extracts the title, text, and published date when present.",
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

function resolveEnabledTools(enabledTools?: string[]) {
  const next = new Set(enabledTools ?? NEWS_MONITOR_DEFAULT_ENABLED_TOOLS);
  next.add("inspect_source_page");
  next.add("inspect_article_page");
  return [...next];
}

export function createNewsMonitorAgent(
  workspaceId: string,
  config?: Partial<NewsMonitorConfig>,
) {
  const resolved: NewsMonitorConfig = {
    name: config?.name ?? "News Monitor",
    instructions: config?.instructions ?? NEWS_MONITOR_DEFAULT_INSTRUCTIONS,
    model: config?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    enabledTools: resolveEnabledTools(config?.enabledTools),
  };

  const tools = [];
  if (resolved.enabledTools.includes("add_source"))
    tools.push(createAddSourceTool(workspaceId));
  if (resolved.enabledTools.includes("list_sources"))
    tools.push(createListSourcesTool(workspaceId));
  if (resolved.enabledTools.includes("remove_source"))
    tools.push(createRemoveSourceTool(workspaceId));
  if (resolved.enabledTools.includes("inspect_source_page"))
    tools.push(createInspectSourceTool());
  if (resolved.enabledTools.includes("inspect_article_page"))
    tools.push(createInspectArticleTool());
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
