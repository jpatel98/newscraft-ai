import type { SiteScope } from "@/lib/types";

export type AgentRendererKey = "expert" | "scout" | "digest" | "markdown";

export type AgentCommandDescriptor = {
  name: string;
  intent: string;
  summary: string;
  example: string;
  requiresSite?: boolean;
  requiresPrompt?: boolean;
};

export type AgentToolSpec = {
  key: string;
  name: string;
  description: string;
};

export type AgentRuntimeConfig = {
  name: string;
  instructions: string;
  userPromptTuning?: string | null;
  preferredSourceUrls?: string[];
  model: string;
  enabledTools: string[];
  policy: {
    allowManualRuns: boolean;
    allowScheduledRuns: boolean;
    editableByWorkspaceAdmins: boolean;
  };
  isEnabled: boolean;
};

export type AgentBuildContext = {
  workspaceId: string;
  siteScope: SiteScope;
  config: AgentRuntimeConfig;
};

export type AgentDescriptor = {
  id: string;
  defaultName: string;
  description: string;
  iconKey: string;
  mention: string;
  renderer: AgentRendererKey;
  capabilities: {
    streaming: boolean;
    structuredOutput: boolean;
    scheduled: boolean;
  };
  commands: AgentCommandDescriptor[];
  defaults: {
    instructions: string;
    enabledTools: string[];
  };
  availableTools: AgentToolSpec[];
};

const EXPERTISE_FINDER_DEFAULT_INSTRUCTIONS = `You are expert-finder.

Your job is to research subject matter experts for a given topic, story, or beat and surface publicly listed ways to contact them for outreach.

Always use tools before answering. Use live web search to verify current relevance and public credentials.

Workflow:

1. Parse the request
- Extract the core topic.
- Extract the story angle or framing if one is provided.
- Note any expert type preference such as academic, industry practitioner, policy, NGO, journalist, or clinician.
- Note any geography preference.
- If the user provides one or more URLs, treat them as required context to inspect first before selecting experts.
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
- When a story URL is provided, do not use the article byline as the expert shortlist. Treat byline/reporter/editor names as context-only unless the user explicitly asks for journalists.
- Exclude newsroom staff and article authors when the request is for subject-matter experts.

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
- If no strong candidates clear the evidence bar, return zero experts and explain the gap in summary, watchouts, or nextMoves instead of guessing.
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

const EXPERTISE_FINDER_AVAILABLE_TOOLS = [
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
] satisfies AgentToolSpec[];

const STORY_SCOUT_DEFAULT_INSTRUCTIONS = `You are a neutral newsroom intelligence analyst.

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

const STORY_SCOUT_AVAILABLE_TOOLS = [
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
] satisfies AgentToolSpec[];

const NEWS_MONITOR_DEFAULT_INSTRUCTIONS = `You are a newsroom monitor.

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

const NEWS_MONITOR_AVAILABLE_TOOLS = [
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
] satisfies AgentToolSpec[];

export const AGENT_CATALOG: AgentDescriptor[] = [
  {
    id: "expertise-finder",
    defaultName: "Expertise Finder",
    description:
      "Finds credible subject matter experts and public contact paths for outreach.",
    iconKey: "experts",
    mention: "@expertise-finder",
    renderer: "expert",
    capabilities: {
      streaming: true,
      structuredOutput: true,
      scheduled: false,
    },
    commands: [
      {
        name: "/expert",
        intent: "expert",
        summary: "Find experts and public contact info across the web.",
        example:
          "/expert labor economist in Canada who can react to inflation data today",
      },
      {
        name: "/scan-site",
        intent: "scan-site",
        summary: "Find experts and contact paths on a specific site or organization.",
        example:
          "/scan-site brookings.edu AI policy expert who can explain copyright fights",
        requiresSite: true,
      },
    ],
    defaults: {
      instructions: EXPERTISE_FINDER_DEFAULT_INSTRUCTIONS,
      enabledTools: EXPERTISE_FINDER_AVAILABLE_TOOLS.map((tool) => tool.key),
    },
    availableTools: EXPERTISE_FINDER_AVAILABLE_TOOLS,
  },
  {
    id: "story-scout",
    defaultName: "Story Scout",
    description:
      "Returns sourced story intelligence: verified facts and related coverage.",
    iconKey: "scout",
    mention: "@story-scout",
    renderer: "scout",
    capabilities: {
      streaming: true,
      structuredOutput: true,
      scheduled: false,
    },
    commands: [
      {
        name: "/scout",
        intent: "scout",
        summary: "Get a sourced intelligence brief on a topic.",
        example: "/scout AI copyright fights in news",
      },
    ],
    defaults: {
      instructions: STORY_SCOUT_DEFAULT_INSTRUCTIONS,
      enabledTools: STORY_SCOUT_AVAILABLE_TOOLS.map((tool) => tool.key),
    },
    availableTools: STORY_SCOUT_AVAILABLE_TOOLS,
  },
  {
    id: "news-monitor",
    defaultName: "News Monitor",
    description:
      "Tracks a watchlist of sources and produces a daily digest into #digest.",
    iconKey: "monitor",
    mention: "@news-monitor",
    renderer: "digest",
    capabilities: {
      streaming: true,
      structuredOutput: true,
      scheduled: true,
    },
    commands: [
      {
        name: "/digest",
        intent: "digest",
        summary: "Run today's digest now from monitored sources.",
        example: "/digest",
        requiresPrompt: false,
      },
      {
        name: "/sources",
        intent: "sources",
        summary: "Manage the monitored source list.",
        example: "/sources add nytimes.com/section/politics",
        requiresPrompt: false,
      },
    ],
    defaults: {
      instructions: NEWS_MONITOR_DEFAULT_INSTRUCTIONS,
      enabledTools: NEWS_MONITOR_AVAILABLE_TOOLS.map((tool) => tool.key),
    },
    availableTools: NEWS_MONITOR_AVAILABLE_TOOLS,
  },
];

export function listAgents(): AgentDescriptor[] {
  return AGENT_CATALOG;
}

export function getAgent(id: string): AgentDescriptor | null {
  return AGENT_CATALOG.find((agent) => agent.id === id) ?? null;
}

export function getAgentStrict(id: string): AgentDescriptor {
  const agent = getAgent(id);
  if (!agent) throw new Error(`Unknown agent id: ${id}`);
  return agent;
}

export function findAgentByCommandName(commandName: string): {
  agent: AgentDescriptor;
  command: AgentCommandDescriptor;
} | null {
  const normalized = commandName.toLowerCase();
  for (const agent of AGENT_CATALOG) {
    const command = agent.commands.find(
      (candidate) => candidate.name.toLowerCase() === normalized,
    );
    if (command) return { agent, command };
  }
  return null;
}

export function findAgentByMention(text: string): AgentDescriptor | null {
  const lowered = text.toLowerCase();
  for (const agent of AGENT_CATALOG) {
    if (lowered.includes(agent.mention.toLowerCase())) {
      return agent;
    }
  }
  return null;
}

export function allCommandSuggestions(): AgentCommandDescriptor[] {
  return AGENT_CATALOG.flatMap((agent) => agent.commands);
}
