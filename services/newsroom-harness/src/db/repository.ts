import type {
	CreateJobInput,
	NewsroomJobDto,
	NewsroomReportDto,
	NewsroomRunDto,
	NewsroomSourceDto,
	RunStatus,
	UpdateJobInput
} from '@newscraft/shared';
import type { HarnessDb } from './database.js';
import { newId, nowIso } from '../util/ids.js';
import { computeNextRunAt } from '../jobs/schedule.js';

interface JobRow {
	id: string;
	name: string;
	description: string;
	prompt: string;
	schedule: string;
	enabled: 0 | 1;
	next_run_at: string | null;
	last_run_at: string | null;
	last_status: string | null;
	last_error: string | null;
	last_delivery_error: string | null;
	deliver: string | null;
	output_format: string;
	created_at: string;
	updated_at: string;
}

interface RunRow {
	id: string;
	job_id: string;
	status: RunStatus;
	trigger: string;
	queued_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	updated_at: string | null;
	elapsed_ms: number | null;
	last_error: string | null;
	job_name?: string | null;
}

interface SourceRow {
	id: string;
	run_id: string;
	job_id: string | null;
	url: string;
	title: string;
	fetched_at: string;
	snippet: string;
	summary: string;
	used: 0 | 1;
}

interface ReportRow {
	id: string;
	run_id: string;
	job_id: string;
	title: string;
	markdown: string;
	created_at: string;
	ingest_status: 'not_configured' | 'sent' | 'failed';
	ingest_error: string | null;
}

export interface StoreSourceInput {
	runId: string;
	jobId: string | null;
	url: string;
	title: string;
	fetchedAt: string;
	snippet: string;
	summary: string;
	used: boolean;
	contentText: string;
	contentHash: string;
	contentType?: string | null;
	statusCode?: number | null;
}

export class HarnessRepository {
	constructor(private db: HarnessDb) {}

	healthcheck(): boolean {
		this.db.prepare('SELECT 1').get();
		return true;
	}

	close(): void {
		this.db.close();
	}

	createJob(input: CreateJobInput): NewsroomJobDto {
		const now = nowIso();
		const id = newId('job');
		const name = (input.name || input.title || '').trim();
		const prompt = (input.prompt || '').trim();
		const schedule = (input.schedule || input.cron || '').trim();
		if (!name) throw new Error('Mission name is required');
		if (!prompt) throw new Error('Mission prompt is required');
		if (!schedule) throw new Error('Mission schedule is required');
		const enabled = input.enabled !== false;
		const nextRunAt = enabled ? computeNextRunAt(schedule, now) : null;
		this.db
			.prepare(
				`INSERT INTO jobs (
					id, name, description, prompt, schedule, enabled, next_run_at, last_status,
					deliver, output_format, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				name,
				String(input.description || '').trim(),
				prompt,
				schedule,
				enabled ? 1 : 0,
				nextRunAt,
				enabled ? 'scheduled' : 'paused',
				input.deliver || null,
				input.output_format || input.outputFormat || 'markdown',
				now,
				now
			);
		return this.getJob(id) as NewsroomJobDto;
	}

	updateJob(id: string, input: UpdateJobInput): NewsroomJobDto {
		const existing = this.requireJob(id);
		const name = input.name ?? input.title ?? existing.name;
		const prompt = input.prompt ?? existing.prompt ?? '';
		const schedule = input.schedule ?? input.cron ?? existing.schedule;
		const enabled = input.enabled ?? existing.enabled;
		const now = nowIso();
		const nextRunAt = enabled ? computeNextRunAt(schedule, now) : null;
		this.db
			.prepare(
				`UPDATE jobs SET
					name = ?, description = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ?,
					last_status = CASE WHEN ? = 0 THEN 'paused' ELSE COALESCE(last_status, 'scheduled') END,
					deliver = ?, output_format = ?, updated_at = ?
				WHERE id = ?`
			)
			.run(
				name.trim(),
				input.description ?? existing.description ?? '',
				prompt.trim(),
				schedule.trim(),
				enabled ? 1 : 0,
				nextRunAt,
				enabled ? 1 : 0,
				input.deliver === undefined ? existing.deliver : input.deliver,
				input.output_format || input.outputFormat || existing.output_format,
				now,
				id
			);
		return this.requireJob(id);
	}

	deleteJob(id: string): boolean {
		return this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
	}

	getJob(id: string): NewsroomJobDto | null {
		const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
		return row ? jobDto(row) : null;
	}

	requireJob(id: string): NewsroomJobDto {
		const job = this.getJob(id);
		if (!job) throw new Error('Mission not found');
		return job;
	}

	listJobs(includeDisabled = false): NewsroomJobDto[] {
		const rows = this.db
			.prepare(
				includeDisabled
					? 'SELECT * FROM jobs ORDER BY created_at DESC'
					: 'SELECT * FROM jobs WHERE enabled = 1 ORDER BY created_at DESC'
			)
			.all() as JobRow[];
		return rows.map(jobDto);
	}

	setJobEnabled(id: string, enabled: boolean): NewsroomJobDto {
		const job = this.requireJob(id);
		const now = nowIso();
		this.db
			.prepare(
				`UPDATE jobs SET enabled = ?, next_run_at = ?, last_status = ?, updated_at = ? WHERE id = ?`
			)
			.run(
				enabled ? 1 : 0,
				enabled ? computeNextRunAt(job.schedule, now) : null,
				enabled ? 'scheduled' : 'paused',
				now,
				id
			);
		return this.requireJob(id);
	}

	createRun(jobId: string, trigger: string): NewsroomRunDto {
		const job = this.requireJob(jobId);
		const now = nowIso();
		const id = newId('run');
		this.db
			.prepare(
				`INSERT INTO runs (id, job_id, status, trigger, queued_at, updated_at)
				 VALUES (?, ?, 'queued', ?, ?, ?)`
			)
			.run(id, job.id, trigger, now, now);
		this.db
			.prepare(
				`UPDATE jobs SET last_status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?`
			)
			.run(now, job.id);
		return this.requireRun(id);
	}

	updateRun(
		id: string,
		input: Partial<Pick<NewsroomRunDto, 'status' | 'started_at' | 'completed_at' | 'elapsed_ms' | 'last_error'>>
	): NewsroomRunDto {
		const current = this.requireRun(id);
		const now = nowIso();
		this.db
			.prepare(
				`UPDATE runs SET
					status = ?, started_at = ?, completed_at = ?, elapsed_ms = ?, last_error = ?, updated_at = ?
				WHERE id = ?`
			)
			.run(
				input.status ?? current.status,
				input.started_at ?? current.started_at,
				input.completed_at ?? current.completed_at,
				input.elapsed_ms ?? current.elapsed_ms,
				input.last_error ?? current.last_error,
				now,
				id
			);
		const updated = this.requireRun(id);
		this.db
			.prepare(
				`UPDATE jobs SET last_status = ?, last_error = ?, last_run_at = COALESCE(?, last_run_at), updated_at = ? WHERE id = ?`
			)
			.run(updated.status, updated.last_error, updated.started_at, now, updated.job_id);
		return updated;
	}

	completeJobSchedule(jobId: string): void {
		const job = this.requireJob(jobId);
		if (!job.enabled) return;
		this.db
			.prepare('UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?')
			.run(computeNextRunAt(job.schedule, nowIso()), nowIso(), jobId);
	}

	requireRun(id: string): NewsroomRunDto {
		const row = this.db
			.prepare(
				`SELECT runs.*, jobs.name AS job_name
				 FROM runs JOIN jobs ON jobs.id = runs.job_id
				 WHERE runs.id = ?`
			)
			.get(id) as RunRow | undefined;
		if (!row) throw new Error('Run not found');
		return runDto(row);
	}

	listRuns(options: { includeCompleted?: boolean; includeRecent?: boolean } = {}): NewsroomRunDto[] {
		const includeCompleted = options.includeCompleted ?? false;
		const rows = this.db
			.prepare(
				includeCompleted
					? `SELECT runs.*, jobs.name AS job_name FROM runs JOIN jobs ON jobs.id = runs.job_id
					   ORDER BY COALESCE(runs.updated_at, runs.queued_at) DESC LIMIT ?`
					: `SELECT runs.*, jobs.name AS job_name FROM runs JOIN jobs ON jobs.id = runs.job_id
					   WHERE runs.status IN ('queued', 'running')
					   ORDER BY COALESCE(runs.updated_at, runs.queued_at) DESC LIMIT ?`
			)
			.all(options.includeRecent ? 50 : 200) as RunRow[];
		return rows.map(runDto);
	}

	dueJobs(now = nowIso()): NewsroomJobDto[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM jobs
				 WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
				 ORDER BY next_run_at ASC LIMIT 10`
			)
			.all(now) as JobRow[];
		return rows.map(jobDto);
	}

	hasActiveRun(jobId: string): boolean {
		const row = this.db
			.prepare(`SELECT id FROM runs WHERE job_id = ? AND status IN ('queued', 'running') LIMIT 1`)
			.get(jobId);
		return Boolean(row);
	}

	addRunStep(runId: string, stepType: string, label: string, status = 'completed', detail?: unknown): void {
		this.db
			.prepare(
				`INSERT INTO run_steps (run_id, step_type, label, status, started_at, completed_at, detail_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(runId, stepType, label, status, nowIso(), nowIso(), detail ? JSON.stringify(detail) : null);
	}

	recordToolCall(input: {
		id?: string;
		runId?: string | null;
		name: string;
		args: unknown;
		result?: unknown;
		status: string;
		error?: string | null;
		startedAt?: string;
		completedAt?: string | null;
	}): string {
		const id = input.id || newId('tool');
		this.db
			.prepare(
				`INSERT INTO tool_calls
				 (id, run_id, name, args_json, result_json, status, started_at, completed_at, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				input.runId || null,
				input.name,
				JSON.stringify(input.args ?? {}),
				input.result === undefined ? null : JSON.stringify(input.result),
				input.status,
				input.startedAt || nowIso(),
				input.completedAt ?? (input.status === 'running' ? null : nowIso()),
				input.error || null
			);
		return id;
	}

	updateToolCall(id: string, input: { result?: unknown; status: string; error?: string | null }): void {
		this.db
			.prepare(
				`UPDATE tool_calls SET result_json = ?, status = ?, completed_at = ?, error = ? WHERE id = ?`
			)
			.run(
				input.result === undefined ? null : JSON.stringify(input.result),
				input.status,
				nowIso(),
				input.error || null,
				id
			);
	}

	storeSource(input: StoreSourceInput): NewsroomSourceDto {
		const snapshotId = newId('snap');
		const sourceId = newId('src');
		this.db
			.prepare(
				`INSERT INTO source_snapshots
				 (id, url, title, fetched_at, content_text, content_hash, content_type, status_code)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				snapshotId,
				input.url,
				input.title,
				input.fetchedAt,
				input.contentText,
				input.contentHash,
				input.contentType || null,
				input.statusCode || null
			);
		this.db
			.prepare(
				`INSERT INTO sources
				 (id, run_id, job_id, snapshot_id, url, title, fetched_at, snippet, summary, used)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				sourceId,
				input.runId,
				input.jobId,
				snapshotId,
				input.url,
				input.title,
				input.fetchedAt,
				input.snippet,
				input.summary,
				input.used ? 1 : 0
			);
		return this.listSourcesForRun(input.runId).find((source) => source.id === sourceId) as NewsroomSourceDto;
	}

	listSourcesForRun(runId: string): NewsroomSourceDto[] {
		const rows = this.db
			.prepare('SELECT id, run_id, job_id, url, title, fetched_at, snippet, summary, used FROM sources WHERE run_id = ?')
			.all(runId) as SourceRow[];
		return rows.map(sourceDto);
	}

	createReport(input: {
		runId: string;
		jobId: string;
		title: string;
		markdown: string;
		ingestStatus?: NewsroomReportDto['ingest_status'];
		ingestError?: string | null;
	}): NewsroomReportDto {
		const id = newId('report');
		this.db
			.prepare(
				`INSERT INTO reports
				 (id, run_id, job_id, title, markdown, created_at, ingest_status, ingest_error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				input.runId,
				input.jobId,
				input.title,
				input.markdown,
				nowIso(),
				input.ingestStatus || 'not_configured',
				input.ingestError || null
			);
		return this.requireReport(id);
	}

	updateReportIngest(id: string, status: NewsroomReportDto['ingest_status'], error: string | null): void {
		this.db.prepare('UPDATE reports SET ingest_status = ?, ingest_error = ? WHERE id = ?').run(status, error, id);
	}

	requireReport(id: string): NewsroomReportDto {
		const row = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined;
		if (!row) throw new Error('Report not found');
		return reportDto(row);
	}

	listReports(): NewsroomReportDto[] {
		return (this.db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all() as ReportRow[]).map(
			reportDto
		);
	}
}

function jobDto(row: JobRow): NewsroomJobDto {
	const state = row.enabled ? row.last_status || 'scheduled' : 'paused';
	return {
		id: row.id,
		name: row.name,
		title: row.name,
		description: row.description,
		prompt: row.prompt,
		schedule: row.schedule,
		cron: row.schedule,
		schedule_display: row.schedule,
		enabled: Boolean(row.enabled),
		state,
		next_run_at: row.next_run_at,
		last_run_at: row.last_run_at,
		last_status: row.last_status,
		last_error: row.last_error,
		last_delivery_error: row.last_delivery_error,
		deliver: row.deliver,
		output_format: row.output_format,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function runDto(row: RunRow): NewsroomRunDto {
	return {
		id: row.id,
		job_id: row.job_id,
		job_name: row.job_name ?? null,
		status: row.status,
		trigger: row.trigger,
		queued_at: row.queued_at,
		started_at: row.started_at,
		completed_at: row.completed_at,
		updated_at: row.updated_at,
		elapsed_ms: row.elapsed_ms,
		last_error: row.last_error
	};
}

function sourceDto(row: SourceRow): NewsroomSourceDto {
	return {
		id: row.id,
		run_id: row.run_id,
		job_id: row.job_id,
		url: row.url,
		title: row.title,
		fetched_at: row.fetched_at,
		snippet: row.snippet,
		summary: row.summary,
		used: Boolean(row.used)
	};
}

function reportDto(row: ReportRow): NewsroomReportDto {
	return {
		id: row.id,
		run_id: row.run_id,
		job_id: row.job_id,
		title: row.title,
		markdown: row.markdown,
		created_at: row.created_at,
		ingest_status: row.ingest_status,
		ingest_error: row.ingest_error
	};
}
