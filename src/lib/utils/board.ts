import path from 'node:path';
import type { BoardChannel, BoardData, BoardPost, AgentJob, AgentRun } from '$lib/types';

export interface ParsedCronMarkdown {
	jobId: string;
	channel: string;
	runTime: string | null;
	schedule: string | null;
	responseMarkdown: string;
	preview: string;
}

function readMetadata(markdown: string, label: string): string | null {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = markdown.match(new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.+?)\\s*$`, 'm'));
	return match?.[1]?.trim() || null;
}

function normalizeTimestamp(value: string | null | undefined): string | null {
	const raw = value?.trim();
	if (!raw) return null;
	const candidate = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
	const date = new Date(candidate);
	return Number.isFinite(date.getTime()) ? date.toISOString() : raw;
}

export function timestampFromFilename(filename: string): string | null {
	const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/);
	if (!match) return null;
	const [, year, month, day, hour, minute, second] = match;
	return normalizeTimestamp(`${year}-${month}-${day} ${hour}:${minute}:${second}`);
}

function previewMarkdown(markdown: string, limit = 220): string {
	const text = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^>\s?/gm, '')
		.replace(/[*_~>|#-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

export function parseCronMarkdown(markdown: string, fallbackJobId = 'unknown'): ParsedCronMarkdown {
	const channel = markdown.match(/^#\s+Cron Job:\s*(.+?)\s*$/m)?.[1]?.trim() || fallbackJobId;
	const jobId = readMetadata(markdown, 'Job ID') || fallbackJobId;
	const runTime = normalizeTimestamp(readMetadata(markdown, 'Run Time'));
	const schedule = readMetadata(markdown, 'Schedule');
	const responseHeading = markdown.match(/^##\s+Response\s*$/m);
	const responseMarkdown =
		responseHeading && responseHeading.index !== undefined
			? markdown.slice(responseHeading.index + responseHeading[0].length).trim()
			: markdown.trim();

	return {
		jobId,
		channel,
		runTime,
		schedule,
		responseMarkdown,
		preview: previewMarkdown(responseMarkdown)
	};
}

function channelSlug(name: string, jobId: string): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48) || 'channel';
	return `${base}-${jobId.slice(0, 8)}`;
}

export function boardPostId(jobId: string, filename: string): string {
	return `${jobId}:${filename.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

export function isSafeChildPath(root: string, candidate: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedCandidate = path.resolve(candidate);
	const relative = path.relative(resolvedRoot, resolvedCandidate);
	return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function postTime(post: BoardPost): number {
	const run = post.runTime ? Date.parse(post.runTime) : Number.NaN;
	if (Number.isFinite(run)) return run;
	const fromName = timestampFromFilename(post.filename);
	const fallback = fromName ? Date.parse(fromName) : Number.NaN;
	return Number.isFinite(fallback) ? fallback : 0;
}

function channelTime(channel: BoardChannel): number {
	const time = channel.latestRunAt ? Date.parse(channel.latestRunAt) : Number.NaN;
	return Number.isFinite(time) ? time : 0;
}

function runTime(run: AgentRun): number {
	const candidates = [run.completedAt, run.updatedAt, run.startedAt, run.queuedAt];
	for (const candidate of candidates) {
		const time = candidate ? Date.parse(candidate) : Number.NaN;
		if (Number.isFinite(time)) return time;
	}
	return 0;
}

function runTimestamp(run: AgentRun): string | null {
	return run.completedAt ?? run.updatedAt ?? run.startedAt ?? run.queuedAt ?? null;
}

export function isActiveRun(run: AgentRun): boolean {
	const status = run.status.toLowerCase();
	return status === 'queued' || status === 'running';
}

interface BuildBoardDataOptions {
	orphanedPostsArchived?: boolean;
}

function channelState(job: AgentJob): string {
	if (!job.enabled) return 'paused';
	return job.state || 'scheduled';
}

export function buildBoardData(
	rawPosts: BoardPost[],
	jobs: AgentJob[],
	runs: AgentRun[] = [],
	options: BuildBoardDataOptions = {}
): BoardData {
	const orphanedPostsArchived = options.orphanedPostsArchived ?? true;
	const jobById = new Map(jobs.map((job) => [job.id, job]));
	const channels = new Map<string, BoardChannel>();
	const sortedRuns = [...runs].sort((a, b) => runTime(b) - runTime(a) || a.id.localeCompare(b.id));
	const runsByJobId = new Map<string, AgentRun[]>();

	for (const run of sortedRuns) {
		const jobRuns = runsByJobId.get(run.jobId) ?? [];
		jobRuns.push(run);
		runsByJobId.set(run.jobId, jobRuns);
	}

	for (const job of jobs) {
		const slug = channelSlug(job.name || job.id, job.id);
		const jobRuns = runsByJobId.get(job.id) ?? [];
		const activeRun = jobRuns.find(isActiveRun) ?? null;
		const recentRun = jobRuns[0] ?? null;
		const latestRunAt = [
			job.lastRunAt,
			recentRun?.completedAt,
			recentRun?.updatedAt,
			recentRun?.startedAt,
			recentRun?.queuedAt
		]
			.map((value) => (value ? { value, time: Date.parse(value) } : null))
			.filter((value): value is { value: string; time: number } => value !== null && Number.isFinite(value.time))
			.sort((a, b) => b.time - a.time)[0]?.value ?? null;

		channels.set(slug, {
			slug,
			name: job.name || job.id,
			jobId: job.id,
			active: true,
			state: activeRun?.status ?? channelState(job),
			latestRunAt,
			activeRun,
			recentRun,
			postCount: 0
		});
	}

	const posts = rawPosts
		.map((post) => {
			const job = jobById.get(post.jobId);
			const name = job?.name || post.channel || post.jobId;
			const slug = channelSlug(name, post.jobId);
			const archived = orphanedPostsArchived && !job;
			return {
				...post,
				kind: post.kind ?? 'report',
				channel: name,
				channelSlug: slug,
				archived
			};
		})
		.sort((a, b) => postTime(b) - postTime(a) || a.filename.localeCompare(b.filename));

	const postKeys = new Set(posts.map((post) => `${post.jobId}:${post.runTime ?? ''}`));
	for (const run of sortedRuns) {
		const status = run.status.toLowerCase();
		if (!isActiveRun(run) && !['failed', 'error', 'cancelled', 'canceled'].includes(status)) continue;
		const job = jobById.get(run.jobId);
		const name = job?.name || run.jobName || run.jobId;
		const runAt = runTimestamp(run);
		const key = `${run.jobId}:${runAt ?? ''}`;
		if (postKeys.has(key)) continue;
		const label = status === 'queued' ? 'Queued' : status === 'running' ? 'Running' : 'Failed';
		const detail = run.lastError ? ` ${run.lastError}` : '';
		posts.push({
			id: `run:${run.id}`,
			jobId: run.jobId,
			channel: name,
			channelSlug: channelSlug(name, run.jobId),
			kind: 'run',
			runTime: runAt,
			schedule: job?.scheduleDisplay ?? null,
			filename: '',
			filePathDisplay: null,
			responseMarkdown: run.lastError
				? `**${label}**\n\n${run.lastError}`
				: `_${label} run. No markdown report has been saved yet._`,
			preview: `${label} run.${detail}`.trim(),
			archived: !job,
			runStatus: run.status,
			elapsedMs: run.elapsedMs ?? null,
			lastError: run.lastError ?? null
		});
		postKeys.add(key);
	}
	posts.sort((a, b) => postTime(b) - postTime(a) || a.id.localeCompare(b.id));

	for (const post of posts) {
		const current = channels.get(post.channelSlug);
		const latestRunAt =
			!current?.latestRunAt || postTime(post) > channelTime(current)
				? post.runTime ?? timestampFromFilename(post.filename)
				: current.latestRunAt;
		if (current) {
			current.postCount += 1;
			current.latestRunAt = latestRunAt ?? current.latestRunAt ?? null;
		} else {
			channels.set(post.channelSlug, {
				slug: post.channelSlug,
				name: post.channel,
				jobId: post.jobId,
				active: !post.archived,
				state: post.archived ? 'archived' : 'saved',
				latestRunAt,
				activeRun: null,
				recentRun: (runsByJobId.get(post.jobId) ?? [])[0] ?? null,
				postCount: 1
			});
		}
	}

	return {
		channels: Array.from(channels.values()).sort(
			(a, b) =>
				channelTime(b) - channelTime(a) ||
				Number(b.active) - Number(a.active) ||
				a.name.localeCompare(b.name)
		),
		posts,
		jobs,
		runs: sortedRuns
	};
}
