import { env } from '$env/dynamic/private';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { HermesCommand, HermesSkillDetail, HermesSkillSummary } from '$lib/types';

const execFileAsync = promisify(execFile);
const SCRIPT = 'scripts/hermes-bridge.py';
const DEFAULT_PYTHON = '/home/jigar/.hermes/hermes-agent/venv/bin/python';
const CACHE_MS = 30_000;

const LOCAL_COMMANDS: HermesCommand[] = [
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

interface CacheEntry<T> {
	expires: number;
	value: Promise<T>;
}

const cache = new Map<string, CacheEntry<unknown>>();

async function pythonBin(): Promise<string> {
	if (env.HERMES_PYTHON) return env.HERMES_PYTHON;
	try {
		await access(DEFAULT_PYTHON);
		return DEFAULT_PYTHON;
	} catch {
		return 'python3';
	}
}

async function bridge<T>(args: string[]): Promise<T> {
	const python = await pythonBin();
	const { stdout } = await execFileAsync(python, [SCRIPT, ...args], {
		cwd: process.cwd(),
		timeout: 6000,
		maxBuffer: 5 * 1024 * 1024,
		env: {
			...process.env,
			HERMES_AGENT_DIR: env.HERMES_AGENT_DIR ?? '/home/jigar/.hermes/hermes-agent'
		}
	});
	const parsed = JSON.parse(stdout) as T & { error?: string };
	if (parsed && typeof parsed === 'object' && parsed.error) {
		throw new Error(parsed.error);
	}
	return parsed as T;
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
	const now = Date.now();
	const hit = cache.get(key) as CacheEntry<T> | undefined;
	if (hit && hit.expires > now) return hit.value;
	const value = load().catch((err) => {
		cache.delete(key);
		throw err;
	});
	cache.set(key, { expires: now + CACHE_MS, value });
	return value;
}

function normalizeCommand(raw: Partial<HermesCommand>): HermesCommand | null {
	if (!raw.slash || !raw.name || !raw.description || !raw.kind) return null;
	return {
		name: String(raw.name),
		slash: String(raw.slash),
		description: String(raw.description),
		category: String(raw.category || (raw.kind === 'skill' ? 'Skills' : 'Commands')),
		argsHint: raw.argsHint ? String(raw.argsHint) : undefined,
		kind: raw.kind === 'skill' ? 'skill' : 'builtin',
		enabled: raw.enabled !== false,
		blockedReason: raw.blockedReason ? String(raw.blockedReason) : null
	};
}

function normalizeSkill(raw: Partial<HermesSkillSummary>): HermesSkillSummary | null {
	if (!raw.slash || !raw.name || !raw.path) return null;
	return {
		name: String(raw.name),
		slash: String(raw.slash),
		description: String(raw.description || `Invoke ${raw.slash}`),
		category: raw.category == null ? null : String(raw.category),
		path: String(raw.path),
		enabled: raw.enabled !== false
	};
}

export async function listHermesCommands(): Promise<HermesCommand[]> {
	return cached('commands', async () => {
		let remote: HermesCommand[] = [];
		try {
			const payload = await bridge<{ commands: Partial<HermesCommand>[] }>(['commands']);
			remote = (payload.commands ?? []).map(normalizeCommand).filter((c): c is HermesCommand => !!c);
		} catch {
			remote = [];
		}
		const bySlash = new Map<string, HermesCommand>();
		for (const command of [...LOCAL_COMMANDS, ...remote]) {
			bySlash.set(command.slash.toLowerCase(), command);
		}
		return Array.from(bySlash.values());
	});
}

export async function listHermesSkills(): Promise<HermesSkillSummary[]> {
	return cached('skills', async () => {
		const payload = await bridge<{ skills: Partial<HermesSkillSummary>[] }>(['skills']);
		return (payload.skills ?? []).map(normalizeSkill).filter((s): s is HermesSkillSummary => !!s);
	});
}

export async function getHermesSkillDetail(slug: string): Promise<HermesSkillDetail> {
	return cached(`skill:${slug}`, async () => {
		const payload = await bridge<{ skill: HermesSkillDetail }>(['skill-detail', slug]);
		return {
			...payload.skill,
			frontmatter:
				payload.skill.frontmatter && typeof payload.skill.frontmatter === 'object'
					? payload.skill.frontmatter
					: {},
			supportingFiles: Array.isArray(payload.skill.supportingFiles)
				? payload.skill.supportingFiles.map(String)
				: []
		};
	});
}

export async function expandHermesSkill(
	slash: string,
	instruction: string,
	taskId: string
): Promise<string> {
	const payload = await bridge<{ content: string }>(['expand-skill', slash, instruction, taskId]);
	return String(payload.content || '');
}
