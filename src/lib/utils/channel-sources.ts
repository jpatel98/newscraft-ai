import type { ChannelSource } from '$lib/types';

const WATCHLIST_HEADING = '## Configured Watchlist';

export type ChannelSourceInput = Partial<ChannelSource> & {
	url?: unknown;
	name?: unknown;
	type?: unknown;
	enabled?: unknown;
	sortOrder?: unknown;
};

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function sortOrder(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
	}
	return fallback;
}

export function validateSourceUrl(value: unknown): string {
	const raw = text(value);
	if (!raw) throw new Error('Source URL is required');
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error('Source URL must be a valid URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Source URL must start with http:// or https://');
	}
	return parsed.toString();
}

export function normalizeChannelSource(input: ChannelSourceInput, index = 0): ChannelSource {
	const name = text(input.name);
	if (!name) throw new Error('Source name is required');
	const type = text(input.type) || 'url';
	if (type !== 'url') throw new Error('Only URL sources are supported right now');
	return {
		id: text(input.id) || '',
		type: 'url',
		name,
		url: validateSourceUrl(input.url),
		enabled: input.enabled !== false,
		sortOrder: sortOrder(input.sortOrder, index)
	};
}

export function normalizeChannelSources(value: unknown): ChannelSource[] {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new Error('Sources must be a list');
	return value.map((source, index) => {
		if (!source || typeof source !== 'object' || Array.isArray(source)) {
			throw new Error('Source entries must include a name and URL');
		}
		return normalizeChannelSource(source as ChannelSourceInput, index);
	});
}

function escapeWatchlistLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

export function compileChannelPrompt(basePrompt: string, sources: ChannelSource[] = []): string {
	const prompt = basePrompt.trim();
	const enabledSources = sources
		.filter((source) => source.enabled !== false)
		.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

	if (enabledSources.length === 0) return prompt;

	const lines = enabledSources.map(
		(source) => `- ${escapeWatchlistLine(source.name)}: ${source.url}`
	);

	return `${prompt}

${WATCHLIST_HEADING}
Use these configured sources as starting points for this scheduled run. They are not the whole task; follow the task prompt above.

${lines.join('\n')}`;
}

export interface ChannelConfigOverlay {
	basePrompt: string;
	sources: ChannelSource[];
}

export function overlayChannelSourceConfigs<T extends { id: string; prompt: string | null; sources?: ChannelSource[] }>(
	jobs: T[],
	configs: Map<string, ChannelConfigOverlay>
): T[] {
	return jobs.map((job) => {
		const config = configs.get(job.id);
		if (!config) return { ...job, sources: job.sources ?? [] };
		return {
			...job,
			prompt: config.basePrompt,
			sources: config.sources
		};
	});
}
