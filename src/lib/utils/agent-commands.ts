import type { AgentCommand } from '$lib/types';

/**
 * The web command catalog is intentionally data-only so it can be shared by
 * the composer and the authenticated compatibility endpoint without a network
 * round trip or importing any server runtime into the browser.
 */
export const LOCAL_AGENT_COMMANDS: readonly AgentCommand[] = Object.freeze([
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
		description: 'Check the configured agent runtime health.',
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
	},
	{
		name: 'Feedback',
		slash: '/feedback',
		description: 'Capture this thread with a feedback comment.',
		category: 'Chat',
		argsHint: 'comment',
		kind: 'builtin',
		enabled: true
	},
	{
		name: 'OCVO',
		slash: '/ocvo',
		description: 'On-camera intro, then voice-over. Paste the source copy and shot list.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'SUVO',
		slash: '/suvo',
		description: 'Sound up, then voice-over. Paste the source copy and shot list.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'DVE VO',
		slash: '/dve',
		description: 'Voice-over only, starts on pictures. Paste the source copy.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'SOTVO',
		slash: '/sotvo',
		description: 'OCVO SOTVO, VO SOTVO or SUVO SOTVO. Paste the copy and the clip or transcript.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'Intro',
		slash: '/intro',
		description: 'Package intro, live throw or top-of-show. Paste the notes or reporter script.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'Tease',
		slash: '/tease',
		description: 'Tease or New at Six headline. Paste the story or its intro.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'Headline',
		slash: '/headline',
		description: 'ANT VO headline over video. Paste the story.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	},
	{
		name: 'Banner',
		slash: '/banner',
		description: 'Lower-third banner options. Paste the story.',
		category: 'Writing',
		argsHint: 'source copy',
		kind: 'skill',
		enabled: true
	}
]);

/** Shortcuts the agent's broadcast writing skill handles (OCVO, SUVO, ...). */
export const WRITING_SKILL_SLASHES: ReadonlySet<string> = new Set(
	LOCAL_AGENT_COMMANDS.filter((command) => command.category === 'Writing').map((command) => command.slash)
);

/** Return a mutable snapshot for callers that may locally filter or extend it. */
export function localAgentCommands(): AgentCommand[] {
	return LOCAL_AGENT_COMMANDS.map((command) => ({ ...command }));
}
