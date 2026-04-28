import { env } from '$env/dynamic/private';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BoardData, BoardPost, HermesJob, HermesRun } from '$lib/types';
import { toHermesDeliverTarget, toUiDeliverTarget } from '$lib/utils/cron-delivery';
import {
	boardPostId,
	buildBoardData,
	isSafeChildPath,
	parseCronMarkdown,
	timestampFromFilename
} from '$lib/utils/board';
import {
	clearAllChannelPosts,
	deleteChannelPostsByJobIds,
	listChannelPosts,
	renameChannelPostsForJob,
	upsertChannelPost
} from '$lib/server/db/channel-posts';
import { listHiddenChannelJobIds, unhideChannelJobId } from '$lib/server/db/hidden-channels';
import { hermesFetch } from './transport';

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_ENDPOINTS = [
	'/api/runs?include_completed=true&include_recent=true',
	'/api/job-runs?include_completed=true&include_recent=true',
	'/api/jobs/runs?include_completed=true&include_recent=true',
	'/api/cron/runs?include_completed=true&include_recent=true'
];
const RUN_FETCH_TIMEOUT_MS = 2500;
const RUN_ENDPOINT_SOFT_DISABLE_MS = 60_000;
const RUN_ENDPOINT_HARD_DISABLE_MS = 10 * 60_000;
const runEndpointDisabledUntil = new Map<string, number>();

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

function numberValue(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
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
		prompt: stringValue(raw.prompt),
		scheduleDisplay:
			stringValue(raw.schedule_display ?? raw.scheduleDisplay ?? raw.schedule ?? raw.cron) || 'unscheduled',
		state,
		enabled,
		nextRunAt: normalizeDate(raw.next_run_at ?? raw.nextRunAt),
		lastRunAt: normalizeDate(raw.last_run_at ?? raw.lastRunAt),
		lastStatus: stringValue(raw.last_status ?? raw.lastStatus),
		lastError: stringValue(raw.last_error ?? raw.lastError),
		lastDeliveryError: stringValue(raw.last_delivery_error ?? raw.lastDeliveryError),
		deliver: toUiDeliverTarget(deliveryValue(raw.deliver ?? raw.delivery ?? raw.delivery_target))
	};
}

function rawJobsFromBody(body: unknown): unknown[] {
	const raw = objectValue(body);
	if (Array.isArray(body)) return body;
	if (Array.isArray(raw?.jobs)) return raw.jobs;
	if (Array.isArray(raw?.data)) return raw.data;
	return [];
}

function rawRunsFromBody(body: unknown): unknown[] {
	const raw = objectValue(body);
	if (Array.isArray(body)) return body;
	if (Array.isArray(raw?.runs)) return raw.runs;
	if (Array.isArray(raw?.job_runs)) return raw.job_runs;
	if (Array.isArray(raw?.jobRuns)) return raw.jobRuns;
	if (Array.isArray(raw?.active_runs)) return raw.active_runs;
	if (Array.isArray(raw?.activeRuns)) return raw.activeRuns;
	if (Array.isArray(raw?.data)) return raw.data;
	return [];
}

function embeddedRunsFromJob(rawJob: unknown): unknown[] {
	const raw = objectValue(rawJob);
	if (!raw) return [];
	const runs: unknown[] = [];
	for (const key of ['runs', 'recent_runs', 'recentRuns', 'history']) {
		const value = raw[key];
		if (Array.isArray(value)) runs.push(...value);
	}
	for (const key of ['run', 'active_run', 'activeRun', 'current_run', 'currentRun', 'last_run', 'lastRun']) {
		const value = raw[key];
		if (objectValue(value)) runs.push(value);
	}
	return runs;
}

function normalizeElapsedMs(raw: Record<string, unknown>, startedAt: string | null, completedAt: string | null): number | null {
	const explicitMs = numberValue(raw.elapsed_ms ?? raw.elapsedMs ?? raw.duration_ms ?? raw.durationMs);
	if (explicitMs !== null) return Math.max(0, Math.round(explicitMs));
	const explicitSeconds = numberValue(raw.elapsed_seconds ?? raw.elapsedSeconds ?? raw.duration_seconds ?? raw.durationSeconds);
	if (explicitSeconds !== null) return Math.max(0, Math.round(explicitSeconds * 1000));
	if (!startedAt) return null;
	const start = Date.parse(startedAt);
	const end = completedAt ? Date.parse(completedAt) : Date.now();
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	return end - start;
}

function normalizeRunStatus(status: string): HermesRun['status'] {
	const normalized = status.toLowerCase();
	if (['pending', 'scheduled'].includes(normalized)) return 'queued';
	if (['started', 'in_progress', 'active'].includes(normalized)) return 'running';
	if (['ok', 'success', 'complete'].includes(normalized)) return 'completed';
	if (['error', 'errored'].includes(normalized)) return 'failed';
	return status;
}

export function normalizeHermesRun(value: unknown, fallbackJob?: HermesJob): HermesRun | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const rawJob = objectValue(raw.job);
	const jobId = stringValue(raw.job_id ?? raw.jobId ?? raw.jobID ?? rawJob?.id) ?? fallbackJob?.id ?? null;
	if (!jobId) return null;

	const status = normalizeRunStatus(
		stringValue(raw.status ?? raw.state ?? raw.phase) ||
			(raw.failed_at || raw.failedAt || raw.error ? 'failed' : raw.completed_at || raw.completedAt ? 'completed' : 'running')
	);
	const queuedAt = normalizeDate(raw.queued_at ?? raw.queuedAt ?? raw.created_at ?? raw.createdAt);
	const startedAt = normalizeDate(raw.started_at ?? raw.startedAt ?? raw.run_at ?? raw.runAt);
	const completedAt = normalizeDate(
		raw.completed_at ?? raw.completedAt ?? raw.finished_at ?? raw.finishedAt ?? raw.ended_at ?? raw.endedAt
	);
	const updatedAt = normalizeDate(raw.updated_at ?? raw.updatedAt);
	const id =
		stringValue(raw.id ?? raw.run_id ?? raw.runId ?? raw.execution_id ?? raw.executionId) ||
		[jobId, status, completedAt ?? startedAt ?? queuedAt ?? updatedAt ?? 'run'].join(':');

	return {
		id,
		jobId,
		jobName:
			stringValue(raw.job_name ?? raw.jobName ?? raw.name ?? rawJob?.name ?? rawJob?.title) ?? fallbackJob?.name ?? null,
		status,
		queuedAt,
		startedAt,
		completedAt,
		updatedAt,
		elapsedMs: normalizeElapsedMs(raw, startedAt, completedAt),
		lastError: stringValue(raw.last_error ?? raw.lastError ?? raw.error ?? raw.error_message ?? raw.errorMessage)
	};
}

function dedupeRuns(runs: HermesRun[]): HermesRun[] {
	const byId = new Map<string, HermesRun>();
	for (const run of runs) byId.set(run.id, run);
	return Array.from(byId.values());
}

async function fetchHermesJobsBody(): Promise<unknown> {
	const response = await hermesFetch('/api/jobs?include_disabled=true', {
		method: 'GET',
		signal: AbortSignal.timeout(5000)
	});
	if (!response.ok) throw new Error(`Hermes jobs ${response.status}: ${await response.text()}`);
	return response.json();
}

async function listHermesJobsWithRuns(): Promise<{ jobs: HermesJob[]; runs: HermesRun[] }> {
	const body = await fetchHermesJobsBody();
	const rawJobs = rawJobsFromBody(body);
	const jobs = rawJobs.map(normalizeHermesJob).filter((job): job is HermesJob => Boolean(job));
	const jobsById = new Map(jobs.map((job) => [job.id, job]));
	const runs = rawJobs.flatMap((rawJob) => {
		const job = normalizeHermesJob(rawJob);
		return embeddedRunsFromJob(rawJob)
			.map((run) => normalizeHermesRun(run, job ?? undefined))
			.filter((run): run is HermesRun => Boolean(run));
	});
	return { jobs, runs: dedupeRuns(runs.map((run) => ({ ...run, jobName: run.jobName ?? jobsById.get(run.jobId)?.name ?? null }))) };
}

export async function listHermesJobs(): Promise<HermesJob[]> {
	return (await listHermesJobsWithRuns()).jobs;
}

export async function listHermesRuns(jobs: HermesJob[] = []): Promise<HermesRun[]> {
	const jobsById = new Map(jobs.map((job) => [job.id, job]));
	const now = Date.now();
	for (const endpoint of RUN_ENDPOINTS) {
		const disabledUntil = runEndpointDisabledUntil.get(endpoint) ?? 0;
		if (disabledUntil > now) continue;
		try {
			const response = await hermesFetch(endpoint, {
				method: 'GET',
				signal: AbortSignal.timeout(RUN_FETCH_TIMEOUT_MS)
			});
			if (response.status === 404 || response.status === 400) {
				runEndpointDisabledUntil.set(endpoint, now + RUN_ENDPOINT_HARD_DISABLE_MS);
				continue;
			}
			if (!response.ok) {
				runEndpointDisabledUntil.set(endpoint, now + RUN_ENDPOINT_SOFT_DISABLE_MS);
				continue;
			}
			runEndpointDisabledUntil.delete(endpoint);
			const body = await response.json();
			return dedupeRuns(
				rawRunsFromBody(body)
					.map((run) => normalizeHermesRun(run))
					.filter((run): run is HermesRun => Boolean(run))
					.map((run) => ({ ...run, jobName: run.jobName ?? jobsById.get(run.jobId)?.name ?? null }))
			);
		} catch {
			runEndpointDisabledUntil.set(endpoint, now + RUN_ENDPOINT_SOFT_DISABLE_MS);
			continue;
		}
	}
	return [];
}

async function syncCronOutputToDb(jobs: HermesJob[], hiddenJobIds: ReadonlySet<string>): Promise<void> {
	const root = cronOutputRoot();
	let folders;
	try {
		folders = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}

	const jobNames = new Map(jobs.map((job) => [job.id, job.name]));
	for (const folder of folders) {
		if (!folder.isDirectory()) continue;
		if (hiddenJobIds.has(folder.name)) continue;
		const dirPath = path.join(root, folder.name);
		if (!isSafeChildPath(root, dirPath)) continue;

		const files = await readdir(dirPath, { withFileTypes: true });
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith('.md')) continue;
			const filePath = path.join(dirPath, file.name);
			if (!isSafeChildPath(root, filePath)) continue;

			const markdown = await readFile(filePath, 'utf8');
			const fileStat = await stat(filePath);
			const parsed = parseCronMarkdown(markdown, folder.name);
			const jobId = parsed.jobId || folder.name;
			if (hiddenJobIds.has(jobId)) continue;
			const channel = jobNames.get(jobId) || parsed.channel || jobId;
			const runTime = parsed.runTime ?? timestampFromFilename(file.name);

			upsertChannelPost({
				id: boardPostId(jobId, file.name),
				jobId,
				channel,
				runTime,
				schedule: parsed.schedule,
				filename: file.name,
				filePathDisplay: path.join(folder.name, file.name),
				responseMarkdown: parsed.responseMarkdown,
				preview: parsed.preview,
				sourceMtimeMs: fileStat.mtimeMs
			});
		}
	}
}

function listBoardPostsFromDb(): BoardPost[] {
	return listChannelPosts().map((row) => ({
		id: row.id,
		jobId: row.jobId,
		channel: row.channel,
		channelSlug: '',
		kind: 'report',
		runTime: row.runTime,
		schedule: row.schedule,
		filename: row.filename,
		filePathDisplay: row.filePathDisplay,
		responseMarkdown: row.responseMarkdown,
		preview: row.preview,
		archived: false
	}));
}

async function listCronPostsFromFilesystem(
	jobs: HermesJob[],
	hiddenJobIds: ReadonlySet<string>
): Promise<BoardPost[]> {
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
		if (hiddenJobIds.has(folder.name)) continue;
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
			if (hiddenJobIds.has(jobId)) continue;
			const channel = jobNames.get(jobId) || parsed.channel || jobId;
			const runTime = parsed.runTime ?? timestampFromFilename(file.name);
			posts.push({
				id: boardPostId(jobId, file.name),
				jobId,
				channel,
				channelSlug: '',
				kind: 'report',
				runTime,
				schedule: parsed.schedule,
				filename: file.name,
				filePathDisplay: path.join(folder.name, file.name),
				responseMarkdown: parsed.responseMarkdown,
				preview: parsed.preview,
				archived: false
			});
		}
	}
	return posts;
}

export async function boardData(): Promise<BoardData> {
	const hiddenJobIds = new Set(listHiddenChannelJobIds());
	let jobs: HermesJob[] = [];
	let runs: HermesRun[] = [];
	let jobsError: string | null = null;
	try {
		const live = await listHermesJobsWithRuns();
		jobs = live.jobs.filter((job) => !hiddenJobIds.has(job.id));
		runs = live.runs.filter((run) => !hiddenJobIds.has(run.jobId));
	} catch (err) {
		jobsError = err instanceof Error ? err.message : String(err);
	}
	if (!jobsError) {
		runs = dedupeRuns([...runs, ...(await listHermesRuns(jobs))]).filter(
			(run) => !hiddenJobIds.has(run.jobId)
		);
	}
	let posts: BoardPost[] = [];
	try {
		await syncCronOutputToDb(jobs, hiddenJobIds);
		posts = listBoardPostsFromDb().filter((post) => !hiddenJobIds.has(post.jobId));
	} catch {
		posts = await listCronPostsFromFilesystem(jobs, hiddenJobIds);
	}
	return { ...buildBoardData(posts, jobs, runs), jobsError };
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

export interface CreateHermesJobInput {
	name: string;
	schedule: string;
	prompt: string;
	enabled?: boolean;
	deliver?: string | null;
}

export async function createHermesJob(input: CreateHermesJobInput): Promise<HermesJob | null> {
	const payload = {
		name: input.name,
		title: input.name,
		schedule: input.schedule,
		cron: input.schedule,
		prompt: input.prompt,
		enabled: input.enabled ?? true,
		deliver: toHermesDeliverTarget(input.deliver)
	};
	const response = await hermesFetch('/api/jobs', {
		method: 'POST',
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok) throw new Error(`Hermes job create ${response.status}: ${await response.text()}`);
	const text = await response.text();
	if (!text.trim()) return null;
	const body = JSON.parse(text);
	const job = normalizeHermesJob(body?.job ?? body?.data ?? body) ?? null;
	if (job) unhideChannelJobId(job.id);
	return job;
}

export interface UpdateHermesJobInput {
	name?: string | null;
	schedule?: string | null;
	prompt?: string | null;
	deliver?: string | null;
	enabled?: boolean;
}

export async function updateHermesJob(id: string, input: UpdateHermesJobInput): Promise<HermesJob | null> {
	if (!JOB_ID_RE.test(id)) throw new Error('Invalid job id');
	const payload: Record<string, unknown> = {};
	if (typeof input.name === 'string') {
		const name = input.name.trim();
		if (name) {
			payload.name = name;
			payload.title = name;
		}
	}
	if (typeof input.schedule === 'string') {
		const schedule = input.schedule.trim();
		if (schedule) {
			payload.schedule = schedule;
			payload.cron = schedule;
		}
	}
	if (typeof input.prompt === 'string') {
		payload.prompt = input.prompt.trim();
	}
	if (typeof input.deliver === 'string') {
		payload.deliver = toHermesDeliverTarget(input.deliver);
	}
	if (typeof input.enabled === 'boolean') payload.enabled = input.enabled;

	const response = await hermesFetch(`/api/jobs/${encodeURIComponent(id)}`, {
		method: 'PATCH',
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok) throw new Error(`Hermes job update ${response.status}: ${await response.text()}`);
	const text = await response.text();
	if (!text.trim()) return null;
	const body = JSON.parse(text);
	const job = normalizeHermesJob(body?.job ?? body?.data ?? body) ?? null;
	if (job) unhideChannelJobId(job.id);
	if (job?.name) renameChannelPostsForJob(job.id, job.name);
	return job;
}

export async function deleteHermesJob(id: string): Promise<void> {
	if (!JOB_ID_RE.test(id)) throw new Error('Invalid job id');
	const response = await hermesFetch(`/api/jobs/${encodeURIComponent(id)}`, {
		method: 'DELETE',
		signal: AbortSignal.timeout(15000)
	});
	if (!response.ok) throw new Error(`Hermes job delete ${response.status}: ${await response.text()}`);
	deleteChannelPostsByJobIds([id]);
}

export async function deleteAllHermesJobs(): Promise<{ deleted: number; failed: string[] }> {
	const jobs = await listHermesJobs();
	if (jobs.length === 0) {
		clearAllChannelPosts();
		return { deleted: 0, failed: [] };
	}

	let deleted = 0;
	const failed: string[] = [];
	for (const job of jobs) {
		try {
			await deleteHermesJob(job.id);
			deleted += 1;
		} catch (err) {
			failed.push(`${job.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (failed.length === 0) clearAllChannelPosts();
	return { deleted, failed };
}
