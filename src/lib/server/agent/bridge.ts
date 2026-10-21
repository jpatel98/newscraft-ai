import type { AgentCommand, AgentSkillDetail, AgentSkillSummary } from '$lib/types';
import { localAgentCommands, WRITING_SKILL_SLASHES } from '$lib/utils/agent-commands';

export async function listAgentCommands(): Promise<AgentCommand[]> {
	return localAgentCommands();
}

export async function listAgentSkills(): Promise<AgentSkillSummary[]> {
	return [];
}

export async function getAgentSkillDetail(slug: string): Promise<AgentSkillDetail> {
	throw new Error(`Skill not found: ${slug}`);
}

/**
 * Writing skills run in the agent: the shortcut stays at the head of the
 * message so the worker loads the broadcast writing skill for that format.
 */
export async function expandAgentSkill(
	slash: string,
	instruction: string,
	_taskId: string
): Promise<string> {
	if (!WRITING_SKILL_SLASHES.has(slash)) throw new Error(`Skill command is not available: ${slash}`);
	return instruction.trim() ? `${slash}\n${instruction.trim()}` : '';
}
