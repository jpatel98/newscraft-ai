import { Agent, run, tool, webSearchTool } from "@openai/agents";
import { load } from "cheerio";
import { z } from "zod";
import { isAllowedDomain } from "@/lib/site-scope";
import type { ExpertiseFinderResult, SiteScope } from "@/lib/types";

const sourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
});

const contactLinkSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});

const expertSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  organization: z.string().min(1),
  whyRelevant: z.string().min(1),
  email: z.string().default("not publicly listed"),
  phone: z.string().default(""),
  website: z.string().default(""),
  socials: z.array(contactLinkSchema).max(3).default([]),
  otherLinks: z.array(sourceSchema).max(4).default([]),
  source: sourceSchema,
  contactNote: z.string().default(""),
});

export const expertiseFinderResultSchema = z.object({
  topic: z.string().min(1),
  storyAngle: z.string().default(""),
  summary: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  experts: z.array(expertSchema).max(10).default([]),
  nextMoves: z.array(z.string().min(1)).max(4).default([]),
  watchouts: z.array(z.string().min(1)).max(3).default([]),
});

function stripCitationMarkers(text: string) {
  return text.replace(/ ?cite[^]+/g, "").replace(/\s+/g, " ").trim();
}

function sanitizeExpertiseResult(result: ExpertiseFinderResult): ExpertiseFinderResult {
  return {
    ...result,
    topic: stripCitationMarkers(result.topic),
    storyAngle: stripCitationMarkers(result.storyAngle),
    summary: stripCitationMarkers(result.summary),
    experts: result.experts.map((expert) => ({
      ...expert,
      name: stripCitationMarkers(expert.name),
      role: stripCitationMarkers(expert.role),
      organization: stripCitationMarkers(expert.organization),
      whyRelevant: stripCitationMarkers(expert.whyRelevant),
      email: stripCitationMarkers(expert.email),
      phone: stripCitationMarkers(expert.phone),
      website: expert.website,
      socials: expert.socials.map((link) => ({
        label: stripCitationMarkers(link.label),
        value: stripCitationMarkers(link.value),
      })),
      otherLinks: expert.otherLinks.map((source) => ({
        title: stripCitationMarkers(source.title),
        url: source.url,
      })),
      source: {
        title: stripCitationMarkers(expert.source.title),
        url: expert.source.url,
      },
      contactNote: stripCitationMarkers(expert.contactNote),
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

export const EXPERTISE_FINDER_DEFAULT_INSTRUCTIONS = `You are expert-finder.

Your job is to research subject matter experts for a given topic, story, or beat and surface publicly listed ways to contact them for outreach.

Always use tools before answering. Use live web search to verify current relevance and public credentials.

Workflow:

1. Parse the request
- Extract the core topic.
- Extract the story angle or framing if one is provided.
- Note any expert type preference such as academic, industry practitioner, policy, NGO, journalist, or clinician.
- Note any geography preference.
- Default geography to Canada when the user does not explicitly request a different region.
- Default to 5 experts when the user does not specify a number.
- If the request is vague, make a reasonable inference and proceed. Reflect assumptions briefly in the summary or watchouts.

2. Identify expert candidates
- For every request, prioritize Canadian voices first: Canadian experts, Canadian institutions, and people with direct Canadian context.
- First check the Informed Perspectives database at https://informedperspectives.org/programs/database-of-experts/ before any broader web search whenever the request is Canadian, journalism-related, policy-related, or plausibly covered there.
- If direct browsing to that database is weak or unavailable, use the site's own pages, filters, or search-oriented pages before broadening outward.
- If the database does not return strong matches, expand to broader web search.
- Prioritize academic researchers, industry practitioners, policy or NGO voices, think tank analysts, and frequently quoted media sources.
- Prefer people with a clear public record of expertise, not generic spokespeople or PR staff.
- For every shortlisted expert, verify at least one public source showing they have been quoted or interviewed in credible media.
- Prefer experts with recent media quote history.
- If media-quote evidence is missing, exclude that candidate unless the user explicitly asks for broader options.
- Only include non-Canadian experts when there are not enough strong Canadian matches, and label them as fallback options.

3. Find contact information
- Attempt contact discovery in this order:
  1. Institutional email or directory page
  2. Personal or professional website
  3. Scholar or institutional profile with verified contact details
  4. Public social handles or LinkedIn for DM outreach
  5. Media or press office contact when the expert's direct contact is not public
- Only surface contact details that are publicly listed.
- Never infer, guess, reconstruct, or pattern-match an email address.
- If no direct public contact is available, say so clearly and provide the best public fallback channel.

4. Output rules
- Return 3 to 5 experts by default, up to 10 when the user asks for more.
- If evidence is weak, return fewer experts and explain the gap.
- Every expert must have at least one public source confirming their expertise.
- Every expert entry should be practical for outreach: role, why they fit, public contact path, and the best confirming source.
- Favor diversity of institution, geography, and perspective when it improves the list.
- Skip anyone whose relevance cannot be confirmed with a public link.

Structured output requirements:
- topic: the core topic in plain English
- storyAngle: the story angle if provided, otherwise an empty string
- summary: a concise editorial note about the mix of experts found and any sourcing assumptions
- confidence: high, medium, or low
- experts: an ordered list of experts

For each expert:
- name: full name
- role: job title
- organization: institution or organization
- whyRelevant: 1 to 2 sentences on why they are a strong source for this specific ask
- email: publicly listed email, or exactly "not publicly listed"
- phone: publicly listed phone number, or empty string
- website: best public profile or homepage URL, or empty string
- socials: public social or LinkedIn links as labeled entries, for example "X", "@handle" or "LinkedIn", "https://linkedin..."
- otherLinks: extra useful public links such as faculty pages, AUB profile pages, media pages, or press office pages
- source: the single best URL confirming their expertise
- contactNote: use this only when direct contact is unavailable or when a fallback route matters

Do not include markdown in structured fields. Keep the tone practical and producer-friendly.`;

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
  userPromptTuning?: string | null;
  preferredSourceUrls?: string[];
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
    userPromptTuning: config?.userPromptTuning ?? null,
    preferredSourceUrls: config?.preferredSourceUrls ?? [],
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
  const userTuningInstructions = buildUserTuningInstructions(
    resolved.userPromptTuning,
    resolved.preferredSourceUrls,
  );

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
    instructions: [
      resolved.instructions,
      siteInstructions,
      userTuningInstructions,
      CANADIAN_VOICE_REQUIREMENT_INSTRUCTIONS,
      MEDIA_QUOTE_REQUIREMENT_INSTRUCTIONS,
    ]
      .filter(Boolean)
      .join("\n\n"),
    outputType: expertiseFinderResultSchema,
    tools,
  });
}

function buildUserTuningInstructions(
  userPromptTuning: string | null | undefined,
  preferredSourceUrls: string[] | null | undefined,
) {
  const cleanedTuning = userPromptTuning?.trim() ?? "";
  const cleanedSources = (preferredSourceUrls ?? [])
    .map((source) => source.trim())
    .filter(Boolean);

  if (!cleanedTuning && cleanedSources.length === 0) return "";

  return [
    "Workspace preferences (set in agent settings):",
    cleanedTuning
      ? `- Editorial preferences: ${cleanedTuning}`
      : "",
    cleanedSources.length > 0
      ? `- Check these sources early before broadening out: ${cleanedSources.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const CANADIAN_VOICE_REQUIREMENT_INSTRUCTIONS = `Canadian voice requirement (non-optional):
- Focus on Canadian voices first for every request, even when the user does not specify geography.
- Prefer experts based in Canada or with direct Canadian policy, institutional, or community context.
- Keep the list majority-Canadian whenever strong candidates exist.
- If there are not enough strong Canadian matches, add clearly labeled non-Canadian fallback options and explain the gap in summary or watchouts.`;

const MEDIA_QUOTE_REQUIREMENT_INSTRUCTIONS = `Media quote requirement (non-optional):
- Before finalizing each expert, verify at least one public source showing they were quoted or interviewed in credible media.
- Keep only candidates with verified media quote history unless the user explicitly asks for broader options.
- In whyRelevant, mention the verified media quote/interview signal when available.`;

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
          const contactLines = [
            `Contact: ${expert.email || "not publicly listed"}`,
            expert.phone ? `Phone: ${expert.phone}` : "",
            expert.website ? `Website: ${expert.website}` : "",
            ...expert.socials.map((social) => `Also: ${social.value}`),
            ...expert.otherLinks.map(
              (link) => `${link.title}: ${link.url}`,
            ),
            expert.contactNote ? `Note: ${expert.contactNote}` : "",
            `Source: ${expert.source.url}`,
          ].filter(Boolean);

          return `${index + 1}) ${expert.name}
Role: ${expert.role}, ${expert.organization}
Why ${expert.name.split(" ")[0]}: ${expert.whyRelevant}
${contactLines.join("\n")}`;
        })
      : ["No strong public experts surfaced yet."];

  return [
    "## Expert Finder Results",
    `Topic: ${result.topic}`,
    result.storyAngle ? `Story angle: ${result.storyAngle}` : "",
    result.summary,
    `Confidence: ${result.confidence}`,
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
