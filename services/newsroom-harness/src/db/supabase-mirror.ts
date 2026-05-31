import postgres, { type Sql } from 'postgres';
import type {
	CreateJobInput,
	NewsroomReportDto,
	NewsroomRunDto,
	NewsroomSourceDto,
	UpdateJobInput
} from '@newscraft/shared';
import type { HarnessDb } from './database.js';
import {
	type AppendEventInput,
	type AppendMemoryInput,
	HarnessRepository,
	type MemoryEntryDto,
	type StoreSourceInput
} from './repository.js';

interface TableSpec {
	name: string;
	columns: string[];
	primaryKey: string;
	appendOnly?: boolean;
	orderBy?: string;
}

const TABLES: TableSpec[] = [
	{
		name: 'jobs',
		primaryKey: 'id',
		columns: [
			'id',
			'workspace_id',
			'name',
			'description',
			'prompt',
			'schedule',
			'enabled',
			'next_run_at',
			'last_run_at',
			'last_status',
			'last_error',
			'last_delivery_error',
			'deliver',
			'output_format',
			'created_at',
			'updated_at'
		],
		orderBy: 'created_at ASC, id ASC'
	},
	{
		name: 'runs',
		primaryKey: 'id',
		columns: [
			'id',
			'job_id',
			'status',
			'trigger',
			'queued_at',
			'started_at',
			'completed_at',
			'updated_at',
			'elapsed_ms',
			'last_error'
		],
		orderBy: 'queued_at ASC, id ASC'
	},
	{
		name: 'run_steps',
		primaryKey: 'id',
		columns: ['id', 'run_id', 'step_type', 'label', 'status', 'started_at', 'completed_at', 'detail_json'],
		orderBy: 'id ASC'
	},
	{
		name: 'tool_calls',
		primaryKey: 'id',
		columns: ['id', 'run_id', 'name', 'args_json', 'result_json', 'status', 'started_at', 'completed_at', 'error'],
		orderBy: 'started_at ASC, id ASC'
	},
	{
		name: 'source_snapshots',
		primaryKey: 'id',
		columns: ['id', 'url', 'title', 'fetched_at', 'content_text', 'content_hash', 'content_type', 'status_code'],
		orderBy: 'fetched_at ASC, id ASC'
	},
	{
		name: 'sources',
		primaryKey: 'id',
		columns: ['id', 'run_id', 'job_id', 'snapshot_id', 'url', 'title', 'fetched_at', 'snippet', 'summary', 'used'],
		orderBy: 'fetched_at ASC, id ASC'
	},
	{
		name: 'reports',
		primaryKey: 'id',
		columns: ['id', 'run_id', 'job_id', 'title', 'markdown', 'created_at', 'ingest_status', 'ingest_error'],
		orderBy: 'created_at ASC, id ASC'
	},
	{
		name: 'events',
		primaryKey: 'id',
		appendOnly: true,
		columns: [
			'id',
			'workspace_id',
			'story_id',
			'job_id',
			'run_id',
			'agent',
			'kind',
			'payload_json',
			'sources_json',
			'parent_event_id',
			'cost_metadata_json',
			'created_at'
		],
		orderBy: 'created_at ASC, id ASC'
	},
	{
		name: 'memory_entries',
		primaryKey: 'id',
		appendOnly: true,
		columns: ['id', 'workspace_id', 'tier', 'scope_id', 'key', 'kind', 'value_json', 'actor', 'created_at'],
		orderBy: 'created_at ASC, id ASC'
	}
];

export class SupabaseMirroredHarnessRepository extends HarnessRepository {
	readonly ready: Promise<void>;

	constructor(db: HarnessDb, private mirror: SupabaseHarnessMirror) {
		super(db);
		this.ready = mirror.start();
	}

	override async close(): Promise<void> {
		await this.mirror.close();
		await super.close();
	}

	override appendEvent(input: AppendEventInput) {
		const event = super.appendEvent(input);
		this.mirror.scheduleSync();
		return event;
	}

	override appendStoryMemory(storyId: string, input: AppendMemoryInput): MemoryEntryDto {
		const entry = super.appendStoryMemory(storyId, input);
		this.mirror.scheduleSync();
		return entry;
	}

	override createJob(input: CreateJobInput) {
		const job = super.createJob(input);
		this.mirror.scheduleSync();
		return job;
	}

	override updateJob(id: string, input: UpdateJobInput) {
		const job = super.updateJob(id, input);
		this.mirror.scheduleSync();
		return job;
	}

	override deleteJob(id: string): boolean {
		const deleted = super.deleteJob(id);
		if (deleted) {
			this.mirror.deleteJob(id);
			this.mirror.scheduleSync();
		}
		return deleted;
	}

	override setJobEnabled(id: string, enabled: boolean) {
		const job = super.setJobEnabled(id, enabled);
		this.mirror.scheduleSync();
		return job;
	}

	override createRun(jobId: string, trigger: string): NewsroomRunDto {
		const run = super.createRun(jobId, trigger);
		this.mirror.scheduleSync();
		return run;
	}

	override updateRun(
		id: string,
		input: Partial<Pick<NewsroomRunDto, 'status' | 'started_at' | 'completed_at' | 'elapsed_ms' | 'last_error'>>
	): NewsroomRunDto {
		const run = super.updateRun(id, input);
		this.mirror.scheduleSync();
		return run;
	}

	override completeJobSchedule(jobId: string): void {
		super.completeJobSchedule(jobId);
		this.mirror.scheduleSync();
	}

	override addRunStep(runId: string, stepType: string, label: string, status = 'completed', detail?: unknown): void {
		super.addRunStep(runId, stepType, label, status, detail);
		this.mirror.scheduleSync();
	}

	override recordToolCall(input: {
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
		const id = super.recordToolCall(input);
		this.mirror.scheduleSync();
		return id;
	}

	override updateToolCall(id: string, input: { result?: unknown; status: string; error?: string | null }): void {
		super.updateToolCall(id, input);
		this.mirror.scheduleSync();
	}

	override storeSource(input: StoreSourceInput): NewsroomSourceDto {
		const source = super.storeSource(input);
		this.mirror.scheduleSync();
		return source;
	}

	override createReport(input: {
		runId: string;
		jobId: string;
		title: string;
		markdown: string;
		ingestStatus?: NewsroomReportDto['ingest_status'];
		ingestError?: string | null;
	}): NewsroomReportDto {
		const report = super.createReport(input);
		this.mirror.scheduleSync();
		return report;
	}

	override updateReportIngest(id: string, status: NewsroomReportDto['ingest_status'], error: string | null): void {
		super.updateReportIngest(id, status, error);
		this.mirror.scheduleSync();
	}
}

export class SupabaseHarnessMirror {
	private sql: Sql;
	private syncTimer: NodeJS.Timeout | null = null;
	private syncPromise: Promise<void> = Promise.resolve();
	private started = false;

	constructor(private db: HarnessDb, databaseUrl: string) {
		this.sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		await this.ensureSchema();
		await this.pullRemoteIntoLocal();
		this.scheduleSync();
	}

	scheduleSync(): void {
		if (this.syncTimer) clearTimeout(this.syncTimer);
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			this.syncPromise = this.syncPromise.then(() => this.syncAllFromLocal()).catch((err) => {
				process.stderr.write(`newsroom-harness Supabase sync failed: ${publicSyncError(err)}\n`);
			});
		}, 250);
		this.syncTimer.unref?.();
	}

	async close(): Promise<void> {
		if (this.syncTimer) {
			clearTimeout(this.syncTimer);
			this.syncTimer = null;
			this.syncPromise = this.syncPromise.then(() => this.syncAllFromLocal()).catch((err) => {
				process.stderr.write(`newsroom-harness Supabase sync failed: ${publicSyncError(err)}\n`);
			});
		}
		await this.syncPromise;
		await this.sql.end({ timeout: 5 });
	}

	deleteJob(id: string): void {
		this.syncPromise = this.syncPromise
			.then(async () => {
				await this.ensureStarted();
				await this.sql.unsafe('DELETE FROM harness.jobs WHERE id = $1', [id]);
			})
			.catch((err) => {
				process.stderr.write(`newsroom-harness Supabase sync failed: ${publicSyncError(err)}\n`);
			});
	}

	private async ensureStarted(): Promise<void> {
		if (!this.started) await this.start();
	}

	private async syncAllFromLocal(): Promise<void> {
		await this.ensureStarted();
		for (const table of TABLES) {
			const rows = this.db
				.prepare(`SELECT ${table.columns.join(', ')} FROM ${table.name} ORDER BY ${table.orderBy || table.primaryKey}`)
				.all() as Record<string, unknown>[];
			for (const row of rows) await this.upsertRemoteRow(table, row);
		}
	}

	private async pullRemoteIntoLocal(): Promise<void> {
		for (const table of TABLES) {
			const rows = (await this.sql.unsafe(
				`SELECT ${table.columns.join(', ')} FROM harness.${table.name} ORDER BY ${table.orderBy || table.primaryKey}`
			)) as Record<string, unknown>[];
			const stmt = this.db.prepare(localUpsertSql(table));
			const tx = this.db.transaction((items: Record<string, unknown>[]) => {
				for (const row of items) stmt.run(...table.columns.map((column) => sqliteValue(row[column])));
			});
			tx(rows);
		}
	}

	private async upsertRemoteRow(table: TableSpec, row: Record<string, unknown>): Promise<void> {
		const placeholders = table.columns.map((_, index) => `$${index + 1}`).join(', ');
		const assignments = table.columns
			.filter((column) => column !== table.primaryKey)
			.map((column) => `${column} = EXCLUDED.${column}`)
			.join(', ');
		const conflict = table.appendOnly
			? `ON CONFLICT (${table.primaryKey}) DO NOTHING`
			: `ON CONFLICT (${table.primaryKey}) DO UPDATE SET ${assignments}`;
		const values = table.columns.map((column) => row[column] ?? null) as any[];
		await this.sql.unsafe(
			`INSERT INTO harness.${table.name} (${table.columns.join(', ')}) VALUES (${placeholders}) ${conflict}`,
			values
		);
	}

	private async ensureSchema(): Promise<void> {
		await this.sql`CREATE SCHEMA IF NOT EXISTS harness`;
		await this.sql.unsafe(`
CREATE TABLE IF NOT EXISTS harness.jobs (
	id text PRIMARY KEY,
	workspace_id text NOT NULL DEFAULT 'default',
	name text NOT NULL,
	description text NOT NULL DEFAULT '',
	prompt text NOT NULL,
	schedule text NOT NULL,
	enabled integer NOT NULL DEFAULT 1,
	next_run_at text,
	last_run_at text,
	last_status text,
	last_error text,
	last_delivery_error text,
	deliver text,
	output_format text NOT NULL DEFAULT 'markdown',
	created_at text NOT NULL,
	updated_at text NOT NULL
);
ALTER TABLE harness.jobs ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default';

CREATE TABLE IF NOT EXISTS harness.runs (
	id text PRIMARY KEY,
	job_id text NOT NULL REFERENCES harness.jobs(id) ON DELETE CASCADE,
	status text NOT NULL,
	trigger text NOT NULL,
	queued_at text,
	started_at text,
	completed_at text,
	updated_at text,
	elapsed_ms integer,
	last_error text
);

CREATE TABLE IF NOT EXISTS harness.run_steps (
	id integer PRIMARY KEY,
	run_id text NOT NULL REFERENCES harness.runs(id) ON DELETE CASCADE,
	step_type text NOT NULL,
	label text NOT NULL,
	status text NOT NULL,
	started_at text NOT NULL,
	completed_at text,
	detail_json text
);

CREATE TABLE IF NOT EXISTS harness.tool_calls (
	id text PRIMARY KEY,
	run_id text REFERENCES harness.runs(id) ON DELETE CASCADE,
	name text NOT NULL,
	args_json text NOT NULL,
	result_json text,
	status text NOT NULL,
	started_at text NOT NULL,
	completed_at text,
	error text
);

CREATE TABLE IF NOT EXISTS harness.source_snapshots (
	id text PRIMARY KEY,
	url text NOT NULL,
	title text NOT NULL,
	fetched_at text NOT NULL,
	content_text text NOT NULL,
	content_hash text NOT NULL,
	content_type text,
	status_code integer
);

CREATE TABLE IF NOT EXISTS harness.sources (
	id text PRIMARY KEY,
	run_id text NOT NULL REFERENCES harness.runs(id) ON DELETE CASCADE,
	job_id text REFERENCES harness.jobs(id) ON DELETE SET NULL,
	snapshot_id text REFERENCES harness.source_snapshots(id) ON DELETE SET NULL,
	url text NOT NULL,
	title text NOT NULL,
	fetched_at text NOT NULL,
	snippet text NOT NULL,
	summary text NOT NULL,
	used integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS harness.reports (
	id text PRIMARY KEY,
	run_id text NOT NULL REFERENCES harness.runs(id) ON DELETE CASCADE,
	job_id text NOT NULL REFERENCES harness.jobs(id) ON DELETE CASCADE,
	title text NOT NULL,
	markdown text NOT NULL,
	created_at text NOT NULL,
	ingest_status text NOT NULL DEFAULT 'not_configured',
	ingest_error text
);

CREATE TABLE IF NOT EXISTS harness.events (
	id text PRIMARY KEY,
	workspace_id text NOT NULL,
	story_id text,
	job_id text,
	run_id text,
	agent text NOT NULL,
	kind text NOT NULL,
	payload_json text NOT NULL DEFAULT '{}',
	sources_json text NOT NULL DEFAULT '[]',
	parent_event_id text,
	cost_metadata_json text,
	created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS harness.memory_entries (
	id text PRIMARY KEY,
	workspace_id text NOT NULL DEFAULT 'default',
	tier text NOT NULL CHECK (tier IN ('story')),
	scope_id text NOT NULL,
	key text NOT NULL,
	kind text NOT NULL,
	value_json text NOT NULL,
	actor text NOT NULL,
	created_at text NOT NULL
);
ALTER TABLE harness.memory_entries ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default';

CREATE OR REPLACE FUNCTION harness.raise_append_only() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_no_update ON harness.events;
DROP TRIGGER IF EXISTS events_no_delete ON harness.events;
CREATE TRIGGER events_no_update BEFORE UPDATE ON harness.events FOR EACH ROW EXECUTE FUNCTION harness.raise_append_only();
CREATE TRIGGER events_no_delete BEFORE DELETE ON harness.events FOR EACH ROW EXECUTE FUNCTION harness.raise_append_only();

DROP TRIGGER IF EXISTS memory_entries_no_update ON harness.memory_entries;
DROP TRIGGER IF EXISTS memory_entries_no_delete ON harness.memory_entries;
CREATE TRIGGER memory_entries_no_update BEFORE UPDATE ON harness.memory_entries FOR EACH ROW EXECUTE FUNCTION harness.raise_append_only();
CREATE TRIGGER memory_entries_no_delete BEFORE DELETE ON harness.memory_entries FOR EACH ROW EXECUTE FUNCTION harness.raise_append_only();

CREATE INDEX IF NOT EXISTS runs_job_idx ON harness.runs(job_id, updated_at);
CREATE INDEX IF NOT EXISTS jobs_next_run_idx ON harness.jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS sources_run_idx ON harness.sources(run_id);
CREATE INDEX IF NOT EXISTS reports_job_idx ON harness.reports(job_id, created_at);
CREATE INDEX IF NOT EXISTS events_workspace_created_idx ON harness.events(workspace_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_story_idx ON harness.events(story_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_job_idx ON harness.events(job_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_run_idx ON harness.events(run_id, created_at, id);
CREATE INDEX IF NOT EXISTS memory_entries_scope_idx ON harness.memory_entries(tier, scope_id, created_at, id);
CREATE INDEX IF NOT EXISTS memory_entries_key_idx ON harness.memory_entries(tier, scope_id, key, created_at, id);
CREATE INDEX IF NOT EXISTS memory_entries_workspace_scope_idx ON harness.memory_entries(workspace_id, tier, scope_id, created_at, id);
`);
	}
}

function localUpsertSql(table: TableSpec): string {
	const placeholders = table.columns.map(() => '?').join(', ');
	const assignments = table.columns
		.filter((column) => column !== table.primaryKey)
		.map((column) => `${column} = excluded.${column}`)
		.join(', ');
	const conflict = table.appendOnly
		? `ON CONFLICT(${table.primaryKey}) DO NOTHING`
		: `ON CONFLICT(${table.primaryKey}) DO UPDATE SET ${assignments}`;
	return `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${placeholders}) ${conflict}`;
}

function sqliteValue(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	return value;
}

function publicSyncError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	return err.message.replace(/postgres:\/\/[^@\s]+@/g, 'postgres://[redacted]@');
}
