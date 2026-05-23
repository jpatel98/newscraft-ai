import type { AgentCommand, AgentSkillDetail, AgentSkillSummary } from '$lib/types';

const LOCAL_COMMANDS: AgentCommand[] = [
	{
		name: 'Help',
		slash: '/help',
		description: 'Show available web commands.',
		category: 'Chat',
		kind: 'builtin',
		enabled: true
	},
	{
		name: 'Commands',
		slash: '/commands',
		description: 'Show available web commands.',
		category: 'Chat',
		kind: 'builtin',
		enabled: true
	},
	{
		name: 'Reasoning',
		slash: '/reasoning',
		description: 'Set reasoning for this thread: low, medium, high, or default.',
		category: 'Chat',
		argsHint: 'low|medium|high|default',
		kind: 'builtin',
		enabled: true
	},
	{
		name: 'Status',
		slash: '/status',
		description: 'Check the configured agent gateway health.',
		category: 'Chat',
		kind: 'builtin',
		enabled: true
	},
	{
		name: 'Profile',
		slash: '/profile',
		description: 'Show the active web agent profile.',
		category: 'Chat',
		kind: 'builtin',
		enabled: true
	}
];

export async function listAgentCommands(): Promise<AgentCommand[]> {
	return LOCAL_COMMANDS;
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
