import { Agent, run, tool, webSearchTool } from "@openai/agents";
import { load } from "cheerio";
import { z } from "zod";
import { isAllowedDomain } from "@/lib/site-scope";
import type { ExpertiseFinderResult, SiteScope } from "@/lib/types";

const sourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
});

const expertSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  organization: z.string().min(1),
  location: z.string().default(""),
  whyRelevant: z.string().min(1),
  reachoutAngle: z.string().min(1),
  bookingSignal: z.enum(["strong", "solid", "speculative"]),
  sources: z.array(sourceSchema).min(1).max(3),
});

export const expertiseFinderResultSchema = z.object({
  brief: z.string().min(1),
  summary: z.string().min(1),
  editorialAngle: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  experts: z.array(expertSchema).max(5).default([]),
  nextMoves: z.array(z.string().min(1)).max(4).default([]),
  watchouts: z.array(z.string().min(1)).max(3).default([]),
});

function stripCitationMarkers(text: string) {
  return text.replace(/ ?cite[^]+/g, "").replace(/\s+/g, " ").trim();
}

function sanitizeExpertiseResult(result: ExpertiseFinderResult): ExpertiseFinderResult {
  return {
    ...result,
    brief: stripCitationMarkers(result.brief),
    summary: stripCitationMarkers(result.summary),
    editorialAngle: stripCitationMarkers(result.editorialAngle),
    experts: result.experts.map((expert) => ({
      ...expert,
      name: stripCitationMarkers(expert.name),
      role: stripCitationMarkers(expert.role),
      organization: stripCitationMarkers(expert.organization),
      location: stripCitationMarkers(expert.location),
      whyRelevant: stripCitationMarkers(expert.whyRelevant),
      reachoutAngle: stripCitationMarkers(expert.reachoutAngle),
      sources: expert.sources.map((source) => ({
        title: stripCitationMarkers(source.title),
        url: source.url,
      })),
    })),
    nextMoves: result.nextMoves.map(stripCitationMarkers),
    watchouts: result.watchouts.map(stripCitationMarkers),
  };
}

const inspectWebpageParameters = z.object({
  url: z.string().min(1),
});

function textFromHtml(html: string) {
  const $ = load(html);

  $("script, style, noscript, iframe, svg, nav, footer, form").remove();

  const title = $("title").first().text().trim();
  const primary = $("main").first().text().trim();
  const article = $("article").first().text().trim();
  const body = $("body").text().trim();
  const text = [primary, article, body]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const links = $("a[href]")
    .toArray()
    .map((anchor) => {
      const href = $(anchor).attr("href");
      const label = $(anchor).text().replace(/\s+/g, " ").trim();

      if (!href) {
        return null;
      }

      try {
        const absolute = new URL(href, "https://placeholder.local");

        return {
          label,
          href:
            absolute.hostname === "placeholder.local"
              ? absolute.pathname + absolute.search
              : absolute.toString(),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return {
    title,
    text,
    links,
  };
}

function scoreCandidateLink(href: string, label: string) {
  const haystack = `${href} ${label}`.toLowerCase();
  let score = 0;

  [
    "expert",
    "experts",
    "people",
    "person",
    "author",
    "authors",
    "faculty",
    "staff",
    "team",
    "fellows",
    "fellow",
    "contributors",
    "speakers",
    "bio",
  ].forEach((keyword) => {
    if (haystack.includes(keyword)) {
      score += 2;
    }
  });

  if (haystack.includes("/tag/")) {
    score -= 1;
  }

  if (haystack.includes("/topic/")) {
    score -= 1;
  }

  return score;
}

function createInspectWebpageTool(siteScope: SiteScope) {
  return tool({
    name: "inspect_webpage",
    description:
      "Fetch a public webpage, extract readable text, and surface likely people or expert directory links on that site.",
    parameters: inspectWebpageParameters,
    async execute({ url }) {
      try {
        new URL(url);
      } catch {
        return {
          ok: false,
          error: `${url} is not a valid URL.`,
        };
      }

      if (!isAllowedDomain(url, siteScope.allowedDomains)) {
        return {
          ok: false,
          error: `This run is scoped to ${siteScope.allowedDomains.join(", ")}. ${url} is outside that scope.`,
        };
      }

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "NewsCraftAI/0.1 newsroom-research-agent",
          },
          signal: AbortSignal.timeout(15000),
        });

        const html = await response.text();
        const parsed = textFromHtml(html);
        const baseUrl = new URL(url);
        const likelyPeoplePages = parsed.links
          .map((link) => {
            if (!link) {
              return null;
            }

            try {
              const absolute = new URL(link.href, baseUrl).toString();

              if (!isAllowedDomain(absolute, siteScope.allowedDomains)) {
                return null;
              }

              return {
                title: link.label || absolute,
                url: absolute,
                score: scoreCandidateLink(absolute, link.label),
              };
            } catch {
              return null;
            }
          })
          .filter((link): link is { title: string; url: string; score: number } => Boolean(link))
          .sort((left, right) => right.score - left.score)
          .slice(0, 8)
          .map(({ title, url: linkUrl }) => ({
            title,
            url: linkUrl,
          }));

        return {
          ok: true,
          url,
          title: parsed.title || url,
          excerpt: parsed.text.slice(0, 5000),
          likelyPeoplePages,
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : `Unable to inspect ${url}.`,
        };
      }
    },
  });
}

function createProbeSiteDirectoriesTool(siteScope: SiteScope) {
  return tool({
    name: "probe_site_directories",
    description:
      "Check a site for likely expert, staff, faculty, author, or contributor directory pages. Use this when the user wants names from one particular site.",
    parameters: z.object({
      url: z.string().min(1),
    }),
    async execute({ url }) {
      try {
        new URL(url);
      } catch {
        return {
          ok: false,
          error: `${url} is not a valid URL.`,
        };
      }

      if (!isAllowedDomain(url, siteScope.allowedDomains)) {
        return {
          ok: false,
          error: `This run is scoped to ${siteScope.allowedDomains.join(", ")}. ${url} is outside that scope.`,
        };
      }

      const baseUrl = new URL(url);
      const candidatePaths = [
        "/experts",
        "/people",
        "/faculty",
        "/team",
        "/staff",
        "/authors",
        "/contributors",
        "/fellows",
        "/speakers",
        "/our-experts",
      ];

      const results = await Promise.all(
        candidatePaths.map(async (path) => {
          const candidateUrl = new URL(path, baseUrl.origin).toString();

          try {
            const response = await fetch(candidateUrl, {
              headers: {
                "User-Agent": "NewsCraftAI/0.1 newsroom-research-agent",
              },
              signal: AbortSignal.timeout(8000),
            });

            if (!response.ok) {
              return null;
            }

            const html = await response.text();
            const parsed = textFromHtml(html);

            return {
              url: candidateUrl,
              title: parsed.title || candidateUrl,
              excerpt: parsed.text.slice(0, 320),
            };
          } catch {
            return null;
          }
        }),
      );

      return {
        ok: true,
        directories: results.filter(Boolean),
      };
    },
  });
}

export const EXPERTISE_FINDER_DEFAULT_INSTRUCTIONS = `You are a senior newsroom booking producer.

Your job is to turn a producer's story brief into a shortlist of credible experts worth contacting.

Always use tools before answering.
Use live web search to verify current relevance.
When a run is scoped to one site, stay inside that organization first and inspect pages directly for bios, directories, author pages, fellows, faculty, staff, or contributor lists.

Prioritize experts who are:
- currently active in the topic area
- affiliated with a credible institution, newsroom, company, or research group
- likely able to speak plainly to a general audience
- backed by recent, public evidence

Output rules:
- Return 3 to 5 experts when possible.
- If the brief is narrow or the evidence is weak, return fewer experts and explain the gap.
- Do not invent email addresses, phone numbers, or private contact information.
- Do not list people without citing at least one public source for each.
- Keep the result practical for a producer: who to book, why now, and what angle they can unlock.
- Favor diversity in geography, institution type, and perspective when it improves the booking list.
- If the user asked for experts from one site, prefer that site's people unless the site obviously lacks the needed expertise.

The summary should sound like an editorial recommendation, not a generic search recap.`;

export const EXPERTISE_FINDER_AVAILABLE_TOOLS = [
  {
    key: "web_search",
    name: "Web search",
    description: "OpenAI web search, scoped to the run's allowed domains if any.",
  },
  {
    key: "inspect_webpage",
    name: "Inspect webpage",
    description:
      "Fetch a scoped URL and extract text + likely people/expert directory links.",
  },
  {
    key: "probe_site_directories",
    name: "Probe site directories",
    description:
      "Probe a domain for /experts, /people, /faculty, /team, /staff, /authors, /contributors paths.",
  },
];

export const EXPERTISE_FINDER_DEFAULT_ENABLED_TOOLS = EXPERTISE_FINDER_AVAILABLE_TOOLS.map(
  (tool) => tool.key,
);

export type ExpertiseFinderConfig = {
  name: string;
  instructions: string;
  model: string;
  enabledTools: string[];
};

export function createExpertiseFinderAgent(
  siteScope: SiteScope,
  config?: Partial<ExpertiseFinderConfig>,
) {
  const resolved: ExpertiseFinderConfig = {
    name: config?.name ?? "Expertise Finder",
    instructions:
      config?.instructions ?? EXPERTISE_FINDER_DEFAULT_INSTRUCTIONS,
    model:
      config?.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    enabledTools: config?.enabledTools ?? EXPERTISE_FINDER_DEFAULT_ENABLED_TOOLS,
  };

  const siteInstructions =
    siteScope.allowedDomains.length > 0
      ? `This run is scoped to these domains first: ${siteScope.allowedDomains.join(", ")}.
Use the scoped web search and site inspection tools before broadening your assumptions.
If preferred URLs are available, inspect them early: ${siteScope.preferredUrls.join(", ")}.`
      : "This run is broad web research unless the user narrows it during the conversation.";

  const tools = [];
  if (resolved.enabledTools.includes("web_search")) {
    tools.push(
      siteScope.allowedDomains.length > 0
        ? webSearchTool({
            searchContextSize: "medium",
            filters: { allowedDomains: siteScope.allowedDomains },
          })
        : webSearchTool({ searchContextSize: "medium" }),
    );
  }
  if (resolved.enabledTools.includes("inspect_webpage")) {
    tools.push(createInspectWebpageTool(siteScope));
  }
  if (resolved.enabledTools.includes("probe_site_directories")) {
    tools.push(createProbeSiteDirectoriesTool(siteScope));
  }

  return new Agent({
    name: resolved.name,
    model: resolved.model,
    instructions: `${resolved.instructions}\n\n${siteInstructions}`,
    outputType: expertiseFinderResultSchema,
    tools,
  });
}

export async function runExpertiseFinder({
  prompt,
  previousResponseId,
  siteScope,
}: {
  prompt: string;
  previousResponseId?: string | null;
  siteScope: SiteScope;
}) {
  const agent = createExpertiseFinderAgent(siteScope);
  const result = previousResponseId
    ? await run(agent, prompt, {
        previousResponseId,
      })
    : await run(agent, prompt);

  return {
    finalOutput: sanitizeExpertiseResult(
      expertiseFinderResultSchema.parse(
        result.finalOutput,
      ) as ExpertiseFinderResult,
    ),
    lastResponseId: result.lastResponseId ?? null,
  };
}

export function formatExpertiseReply(result: ExpertiseFinderResult) {
  const experts =
    result.experts.length > 0
      ? result.experts.map((expert, index) => {
          const sourceList = expert.sources
            .map((source) => `${source.title}: ${source.url}`)
            .join("; ");
          const location = expert.location ? `, ${expert.location}` : "";

          return `${index + 1}. ${expert.name} — ${expert.role}, ${expert.organization}${location}
Why this person: ${expert.whyRelevant}
Booking angle: ${expert.reachoutAngle}
Sources: ${sourceList}`;
        })
      : ["No strong public experts surfaced yet."];

  return [
    result.summary,
    `Editorial angle: ${result.editorialAngle}`,
    `Confidence: ${result.confidence}`,
    "Expert shortlist:",
    ...experts,
    result.nextMoves.length > 0
      ? `Next moves:\n- ${result.nextMoves.join("\n- ")}`
      : "",
    result.watchouts.length > 0
      ? `Watchouts:\n- ${result.watchouts.join("\n- ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
