import type { Agent, AgentOutputType } from "@openai/agents";
import type { AgentBuildContext } from "./catalog";

export async function buildAgentRuntime(
  agentId: string,
  ctx: AgentBuildContext,
): Promise<Agent<unknown, AgentOutputType>> {
  switch (agentId) {
    case "expertise-finder": {
      const { createExpertiseFinderAgent } = await import("./expertise-finder");
      return createExpertiseFinderAgent(
        ctx.siteScope,
        ctx.config,
      ) as Agent<unknown, AgentOutputType>;
    }
    case "story-scout": {
      const { createStoryScoutAgent } = await import("./story-scout");
      return createStoryScoutAgent(
        ctx.config,
      ) as Agent<unknown, AgentOutputType>;
    }
    case "news-monitor": {
      const { createNewsMonitorAgent } = await import("./news-monitor");
      return createNewsMonitorAgent(
        ctx.workspaceId,
        ctx.config,
      ) as Agent<unknown, AgentOutputType>;
    }
    default:
      throw new Error(`Unknown agent id: ${agentId}`);
  }
}
