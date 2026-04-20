import { Agent, tool, webSearchTool } from "@openai/agents";
import { load } from "cheerio";
import { z } from "zod";
import { runWithToolGuard } from "@/lib/agents/tool-utils";

const httpUrlSchema = z
  .string()
  .regex(/^https?:\/\/\S+$/i, "Must be an absolute http(s) URL");

const scoutSourceSchema = z.object({
  title: z.string().min(1),
  url: httpUrlSchema,
});

const scoutAngleSchema = z.object({
  title: z.string().min(1),
  why: z.string().min(1),
  audience: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "ambitious"]),
});

const scoutBackgroundSchema = z.object({
  fact: z.string().min(1),
  source: scoutSourceSchema,
});

const scoutCoverageSchema = z.object({
  outlet: z.string().min(1),
  headline: z.string().min(1),
  url: httpUrlSchema,
  publishedAt: z.string().optional(),
  takeaway: z.string().min(1),
});

const scoutVoiceSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  why: z.string().min(1),
});

export const storyScoutBriefSchema = z.object({
  topic: z.string().min(1),
  summary: z.string().min(1),
  angles: z.array(scoutAngleSchema).max(20).default([]),
  background: z.array(scoutBackgroundSchema).max(40).default([]),
  relatedCoverage: z.array(scoutCoverageSchema).max(40).default([]),
  suggestedVoices: z.array(scoutVoiceSchema).max(20).default([]),
  interviewQuestions: z.array(z.string().min(1)).max(30).default([]),
  watchouts: z.array(z.string().min(1)).max(20).default([]),
  confidence: z.enum(["high", "medium", "low"]),
});

export type StoryScoutBrief = z.infer<typeof storyScoutBriefSchema>;

export function normalizeStoryScoutBrief(brief: StoryScoutBrief): StoryScoutBrief {
  return {
    ...brief,
    angles: brief.angles.slice(0, 6),
    background: brief.background.filter((item) => {
      try {
        new URL(item.source.url);
        return true;
      } catch {
        return false;
      }
    }).slice(0, 8),
    relatedCoverage: brief.relatedCoverage.filter((item) => {
      try {
        new URL(item.url);
        return true;
      } catch {
        return false;
      }
    }).slice(0, 8),
    suggestedVoices: brief.suggestedVoices.slice(0, 5),
    interviewQuestions: brief.interviewQuestions.slice(0, 10),
    watchouts: brief.watchouts.slice(0, 4),
  };
}

const inspectParameters = z.object({
  url: z.string().min(1),
});

const inspectWebpageTool = tool({
  name: "inspect_webpage",
  description:
    "Fetch a public webpage and extract its readable text. Use to deepen context on a single article, press release, or bio page.",
  parameters: inspectParameters,
  async execute({ url }) {
    try {
      new URL(url);
    } catch {
      return { ok: false as const, error: `${url} is not a valid URL.` };
    }
    const outcome = await runWithToolGuard(
      "inspect_webpage",
      async () => {
        const response = await fetch(url, {
          headers: { "User-Agent": "NewsCraftAI/0.1 story-scout" },
          signal: AbortSignal.timeout(15000),
        });
        const html = await response.text();
        const $ = load(html);
        $("script, style, noscript, iframe, nav, footer, form").remove();
        const title = $("title").first().text().trim();
        const text =
          $("article").first().text().trim() ||
          $("main").first().text().trim() ||
          $("body").text().trim();
        const cleaned = text.replace(/\s+/g, " ").trim();

        return {
          url,
          title: title || url,
          excerpt: cleaned.slice(0, 5000),
        };
      },
      { timeoutMs: 15_000, retries: 1 },
    );
    if (!outcome.ok) {
      return {
        ok: false as const,
        error: outcome.error,
        meta: outcome.meta,
      };
    }
    return {
      ok: true as const,
      ...outcome.result,
      meta: outcome.meta,
    };
  },
});

export const STORY_SCOUT_DEFAULT_INSTRUCTIONS = `You are a neutral newsroom intelligence analyst.

Given a topic, return a sourced intelligence brief with facts as-is.

Rules:
- Always search the web before drafting.
- Every background fact must cite a source (title + URL).
- Distinguish clearly between reported fact and unresolved/uncertain information.
- Do not give editorial advice, strategy, coaching, or recommendations.
- Do not tell producers or journalists what they should do or think.
- Keep \`angles\`, \`suggestedVoices\`, \`interviewQuestions\`, and \`watchouts\` empty unless the user explicitly requests those planning sections.
- Prefer recency (past six months) for related coverage unless the story has a longer arc.
- Keep the summary to 2-4 neutral sentences describing what is known right now.
- If reporting is too thin to support sourced background facts, return a gap response with empty structured sections and state that clearly in the summary.
- Never invent names, quotes, or stats. Cite or skip.`;

export const STORY_SCOUT_AVAILABLE_TOOLS = [
  {
    key: "web_search",
    name: "Web search",
    description: "OpenAI web search with high context size for recent coverage.",
  },
  {
    key: "inspect_webpage",
    name: "Inspect webpage",
    description: "Fetch an article or source page and extract its readable text.",
  },
];

export const STORY_SCOUT_DEFAULT_ENABLED_TOOLS = STORY_SCOUT_AVAILABLE_TOOLS.map(
  (tool) => tool.key,
);

export type StoryScoutConfig = {
  name: string;
  instructions: string;
  model: string;
  enabledTools: string[];
};

export function createStoryScoutAgent(config?: Partial<StoryScoutConfig>) {
  const resolved: StoryScoutConfig = {
    name: config?.name ?? "Story Scout",
    instructions: config?.instructions ?? STORY_SCOUT_DEFAULT_INSTRUCTIONS,
    model: config?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    enabledTools: config?.enabledTools ?? STORY_SCOUT_DEFAULT_ENABLED_TOOLS,
  };

  const tools = [];
  if (resolved.enabledTools.includes("web_search")) {
    tools.push(webSearchTool({ searchContextSize: "high" }));
  }
  if (resolved.enabledTools.includes("inspect_webpage")) {
    tools.push(inspectWebpageTool);
  }

  return new Agent({
    name: resolved.name,
    model: resolved.model,
    instructions: resolved.instructions,
    outputType: storyScoutBriefSchema,
    tools,
  });
}
