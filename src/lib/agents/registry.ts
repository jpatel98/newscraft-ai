import type { Agent } from "@openai/agents";
import { createExpertiseFinderAgent } from "./expertise-finder";
import type { SiteScope } from "@/lib/types";

export type AgentRendererKey = "expert" | "scout" | "digest" | "markdown";

export type AgentCommandDescriptor = {
  name: string;
  intent: string;
  summary: string;
  example: string;
  requiresSite?: boolean;
};

export type AgentBuildContext = {
  workspaceId: string;
  siteScope: SiteScope;
};

export type AgentDescriptor = {
  id: string;
  name: string;
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
  build: (ctx: AgentBuildContext) => Agent<unknown, "text" | "json" | any>;
};

export const AGENT_REGISTRY: AgentDescriptor[] = [
  {
    id: "expertise-finder",
    name: "Expertise Finder",
    description:
      "Books credible experts for your story, with citations and a reach-out angle.",
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
        summary: "Find experts across the web.",
        example:
          "/expert labor economist in Canada who can react to inflation data today",
      },
      {
        name: "/scan-site",
        intent: "scan-site",
        summary: "Find experts on a specific site or organization.",
        example:
          "/scan-site brookings.edu AI policy expert who can explain copyright fights",
        requiresSite: true,
      },
    ],
    build: (ctx) => createExpertiseFinderAgent(ctx.siteScope),
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
