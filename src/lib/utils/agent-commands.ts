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
		description: 'Check the configured Hermes runtime health.',
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
	}
]);

/** Return a mutable snapshot for callers that may locally filter or extend it. */
export function localAgentCommands(): AgentCommand[] {
	return LOCAL_AGENT_COMMANDS.map((command) => ({ ...command }));
}
