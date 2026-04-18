import { Agent, tool, webSearchTool } from "@openai/agents";
import { load } from "cheerio";
import { z } from "zod";

const scoutSourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
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
  url: z.string().min(1),
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
  angles: z.array(scoutAngleSchema).min(3).max(6),
  background: z.array(scoutBackgroundSchema).min(3).max(8),
  relatedCoverage: z.array(scoutCoverageSchema).max(8).default([]),
  suggestedVoices: z.array(scoutVoiceSchema).max(5).default([]),
  interviewQuestions: z.array(z.string().min(1)).min(5).max(10),
  watchouts: z.array(z.string().min(1)).max(4).default([]),
  confidence: z.enum(["high", "medium", "low"]),
});

export type StoryScoutBrief = z.infer<typeof storyScoutBriefSchema>;

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

    try {
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
        ok: true as const,
        url,
        title: title || url,
        excerpt: cleaned.slice(0, 5000),
      };
    } catch (error) {
      return {
        ok: false as const,
        error:
          error instanceof Error
            ? error.message
            : `Could not fetch ${url}.`,
      };
    }
  },
});

export const STORY_SCOUT_DEFAULT_INSTRUCTIONS = `You are a senior editorial strategist helping newsroom producers scope a story before a pitch meeting.

Given a topic, return a brief a producer can take straight into the rundown.

Rules:
- Always search the web before drafting.
- Every background fact must cite a source (title + URL).
- Distinguish *reported fact* from *emerging speculation* in your language.
- Angles must be distinct — not three rewordings of the same angle. Cover at least one consumer, one policy, and one industry angle when they apply.
- Interview questions must be open-ended. Avoid yes/no questions.
- If the evidence for a claim is thin, move it to "watchouts" instead of the brief.
- Prefer recency (past six months) for related coverage unless the story has a longer arc.
- Keep the summary to 2–4 sentences framing *why this matters now*.
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
