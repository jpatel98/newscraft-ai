import type { AgentCommand, AgentSkillDetail, AgentSkillSummary } from '$lib/types';
import { localAgentCommands } from '$lib/utils/agent-commands';

export async function listAgentCommands(): Promise<AgentCommand[]> {
	return localAgentCommands();
}

export async function listAgentSkills(): Promise<AgentSkillSummary[]> {
	return [];
}

export async function getAgentSkillDetail(slug: string): Promise<AgentSkillDetail> {
	throw new Error(`Skill not found: ${slug}`);
}

export async function expandAgentSkill(
	slash: string,
	_instruction: string,
	_taskId: string
): Promise<string> {
	throw new Error(`Skill command is not available: ${slash}`);
}
