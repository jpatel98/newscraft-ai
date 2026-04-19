import type { Agent } from "@openai/agents";
import {
  createExpertiseFinderAgent,
  EXPERTISE_FINDER_AVAILABLE_TOOLS,
  EXPERTISE_FINDER_DEFAULT_ENABLED_TOOLS,
  EXPERTISE_FINDER_DEFAULT_INSTRUCTIONS,
} from "./expertise-finder";
import {
  createStoryScoutAgent,
  STORY_SCOUT_AVAILABLE_TOOLS,
  STORY_SCOUT_DEFAULT_ENABLED_TOOLS,
  STORY_SCOUT_DEFAULT_INSTRUCTIONS,
} from "./story-scout";
import {
  createNewsMonitorAgent,
  NEWS_MONITOR_AVAILABLE_TOOLS,
  NEWS_MONITOR_DEFAULT_ENABLED_TOOLS,
  NEWS_MONITOR_DEFAULT_INSTRUCTIONS,
} from "./news-monitor";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (ctx: AgentBuildContext) => Agent<any, any>;
};

export const AGENT_REGISTRY: AgentDescriptor[] = [
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
      enabledTools: EXPERTISE_FINDER_DEFAULT_ENABLED_TOOLS,
    },
    availableTools: EXPERTISE_FINDER_AVAILABLE_TOOLS,
    build: (ctx) => createExpertiseFinderAgent(ctx.siteScope, ctx.config),
  },
  {
    id: "story-scout",
    defaultName: "Story Scout",
    description:
      "Scopes a story — angles, background, related coverage, interview questions.",
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
        summary: "Get a full story brief on a topic.",
        example: "/scout AI copyright fights in news",
      },
    ],
    defaults: {
      instructions: STORY_SCOUT_DEFAULT_INSTRUCTIONS,
      enabledTools: STORY_SCOUT_DEFAULT_ENABLED_TOOLS,
    },
    availableTools: STORY_SCOUT_AVAILABLE_TOOLS,
    build: (ctx) => createStoryScoutAgent(ctx.config),
  },
  {
    id: "news-monitor",
    defaultName: "News Monitor",
    description:
      "Tracks a watchlist of sources and produces a daily digest into #news-digest.",
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
      enabledTools: NEWS_MONITOR_DEFAULT_ENABLED_TOOLS,
    },
    availableTools: NEWS_MONITOR_AVAILABLE_TOOLS,
    build: (ctx) => createNewsMonitorAgent(ctx.workspaceId, ctx.config),
  },
];

export function listAgents(): AgentDescriptor[] {
  return AGENT_REGISTRY;
}

export function getAgent(id: string): AgentDescriptor | null {
  return AGENT_REGISTRY.find((agent) => agent.id === id) ?? null;
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
  for (const agent of AGENT_REGISTRY) {
    const command = agent.commands.find(
      (candidate) => candidate.name.toLowerCase() === normalized,
    );
    if (command) return { agent, command };
  }
  return null;
}

export function findAgentByMention(text: string): AgentDescriptor | null {
  const lowered = text.toLowerCase();
  for (const agent of AGENT_REGISTRY) {
    if (lowered.includes(agent.mention.toLowerCase())) {
      return agent;
    }
  }
  return null;
}

export function allCommandSuggestions(): AgentCommandDescriptor[] {
  return AGENT_REGISTRY.flatMap((agent) => agent.commands);
}
