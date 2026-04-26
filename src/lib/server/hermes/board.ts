import { env } from '$env/dynamic/private';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BoardData, BoardPost, HermesJob } from '$lib/types';
import {
	boardPostId,
	buildBoardData,
	isSafeChildPath,
	parseCronMarkdown,
	timestampFromFilename
} from '$lib/utils/board';
import { hermesFetch } from './transport';

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function cronOutputRoot(): string {
	return env.HERMES_CRON_OUTPUT_DIR || path.join(homedir(), '.hermes', 'cron', 'output');
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function boolValue(value: unknown, fallback = true): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function normalizeDate(value: unknown): string | null {
	const raw = stringValue(value);
	if (!raw) return null;
	const date = new Date(raw);
	if (Number.isFinite(date.getTime())) return date.toISOString();
	const fallback = new Date(`${raw.replace(' ', 'T')}Z`);
	return Number.isFinite(fallback.getTime()) ? fallback.toISOString() : raw;
}

function deliveryValue(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map((v) => stringValue(v)).filter(Boolean).join(', ') || null;
	const obj = objectValue(value);
	if (!obj) return null;
	return stringValue(obj.type) || stringValue(obj.target) || stringValue(obj.name) || null;
}

export function normalizeHermesJob(value: unknown): HermesJob | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const id = stringValue(raw.id ?? raw.job_id);
	if (!id) return null;
	const enabled = boolValue(raw.enabled, true);
	const state = stringValue(raw.state) || (enabled ? 'scheduled' : 'paused');
	const name =
		stringValue(raw.name) ||
		stringValue(raw.title) ||
		stringValue(raw.prompt)?.replace(/^\//, '') ||
		id;

	return {
		id,
		name,
		scheduleDisplay:
			stringValue(raw.schedule_display ?? raw.scheduleDisplay ?? raw.schedule ?? raw.cron) || 'unscheduled',
		state,
		enabled,
		nextRunAt: normalizeDate(raw.next_run_at ?? raw.nextRunAt),
		lastRunAt: normalizeDate(raw.last_run_at ?? raw.lastRunAt),
		lastStatus: stringValue(raw.last_status ?? raw.lastStatus),
		lastError: stringValue(raw.last_error ?? raw.lastError),
		lastDeliveryError: stringValue(raw.last_delivery_error ?? raw.lastDeliveryError),
		deliver: deliveryValue(raw.deliver ?? raw.delivery ?? raw.delivery_target)
	};
}

export async function listHermesJobs(): Promise<HermesJob[]> {
	const response = await hermesFetch('/api/jobs?include_disabled=true', {
		method: 'GET',
		signal: AbortSignal.timeout(5000)
	});
	if (!response.ok) throw new Error(`Hermes jobs ${response.status}: ${await response.text()}`);
	const body = await response.json();
	const rawJobs: unknown[] = Array.isArray(body)
		? body
		: Array.isArray(body?.jobs)
			? body.jobs
			: Array.isArray(body?.data)
				? body.data
				: [];
	return rawJobs.map(normalizeHermesJob).filter((job): job is HermesJob => Boolean(job));
}

async function listCronPosts(jobs: HermesJob[]): Promise<BoardPost[]> {
	const root = cronOutputRoot();
	let folders;
	try {
		folders = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw err;
	}

	const jobNames = new Map(jobs.map((job) => [job.id, job.name]));
	const posts: BoardPost[] = [];
	for (const folder of folders) {
		if (!folder.isDirectory()) continue;
		const dirPath = path.join(root, folder.name);
		if (!isSafeChildPath(root, dirPath)) continue;

		const files = await readdir(dirPath, { withFileTypes: true });
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith('.md')) continue;
			const filePath = path.join(dirPath, file.name);
			if (!isSafeChildPath(root, filePath)) continue;

			const markdown = await readFile(filePath, 'utf8');
			const parsed = parseCronMarkdown(markdown, folder.name);
			const jobId = parsed.jobId || folder.name;
			const channel = jobNames.get(jobId) || parsed.channel || jobId;
			const runTime = parsed.runTime ?? timestampFromFilename(file.name);

			posts.push({
				id: boardPostId(jobId, file.name),
				jobId,
				channel,
				channelSlug: '',
				runTime,
				schedule: parsed.schedule,
				filename: file.name,
				responseMarkdown: parsed.responseMarkdown,
				preview: parsed.preview,
				archived: false
			});
		}
	}
	return posts;
}

export async function boardData(): Promise<BoardData> {
	let jobs: HermesJob[] = [];
	let jobsError: string | null = null;
	try {
		jobs = await listHermesJobs();
	} catch (err) {
		jobsError = err instanceof Error ? err.message : String(err);
	}
	const posts = await listCronPosts(jobs);
	return { ...buildBoardData(posts, jobs), jobsError };
}

export async function runJobAction(id: string, action: 'run' | 'pause' | 'resume'): Promise<HermesJob | null> {
	if (!JOB_ID_RE.test(id)) throw new Error('Invalid job id');
	const response = await hermesFetch(`/api/jobs/${encodeURIComponent(id)}/${action}`, {
		method: 'POST',
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok) throw new Error(`Hermes job ${action} ${response.status}: ${await response.text()}`);
	const text = await response.text();
	if (!text.trim()) return null;
	try {
		const body = JSON.parse(text);
		return normalizeHermesJob(body?.job ?? body) ?? null;
	} catch {
		return null;
	}
}
