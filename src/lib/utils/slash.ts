import type { AgentCommand } from '$lib/types';

export interface SlashParseResult {
	raw: string;
	slash: string;
	name: string;
	args: string;
}

const SLASH_RE = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/;

export function parseSlashCommand(input: string): SlashParseResult | null {
	const raw = input.trim();
	if (!raw.startsWith('/')) return null;
	const match = raw.match(SLASH_RE);
	if (!match) return null;
	const name = match[1].toLowerCase().replaceAll('_', '-');
	return {
		raw,
		slash: `/${name}`,
		name,
		args: (match[2] ?? '').trim()
	};
}

export function filterSlashCommands(commands: AgentCommand[], query: string): AgentCommand[] {
	const q = query.trim().toLowerCase().replaceAll('_', '-').replace(/^\//, '');
	const ranked = commands
		.map((cmd) => {
			const slash = cmd.slash.toLowerCase();
			const name = cmd.name.toLowerCase();
			const desc = cmd.description.toLowerCase();
			let score = -1;
			if (!q) score = cmd.kind === 'builtin' ? 2 : 1;
			else if (slash === `/${q}`) score = 10;
			else if (slash.startsWith(`/${q}`)) score = 8;
			else if (name.includes(q)) score = 5;
			else if (desc.includes(q)) score = 2;
			return { cmd, score };
		})
		.filter((row) => row.score >= 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.cmd.kind !== b.cmd.kind) return a.cmd.kind === 'builtin' ? -1 : 1;
			return a.cmd.slash.localeCompare(b.cmd.slash);
		});
	return ranked.map((row) => row.cmd);
}
