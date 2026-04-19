import type { AgentRuntimeConfig } from "./registry";

export function assertManualAgentRunAllowed(config: AgentRuntimeConfig, agentName: string) {
  if (!config.isEnabled || !config.policy.allowManualRuns) {
    throw new Error(`${agentName} is disabled for manual runs in this workspace.`);
  }
}

export function assertScheduledAgentRunAllowed(
  config: AgentRuntimeConfig,
  agentName: string,
) {
  if (!config.isEnabled || !config.policy.allowScheduledRuns) {
    throw new Error(`${agentName} is disabled for scheduled runs in this workspace.`);
  }
}

