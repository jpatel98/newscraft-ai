import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type HarnessDb = Database.Database;

export function openDatabase(dbPath: string): HarnessDb {
	if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
	const db = new Database(dbPath);
	db.pragma('foreign_keys = ON');
	if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
	ensureSchema(db);
	return db;
}

function ensureSchema(db: HarnessDb): void {
	db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT 'default',
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	prompt TEXT NOT NULL,
	schedule TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	next_run_at TEXT,
	last_run_at TEXT,
	last_status TEXT,
	last_error TEXT,
	last_delivery_error TEXT,
	deliver TEXT,
	output_format TEXT NOT NULL DEFAULT 'markdown',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	status TEXT NOT NULL,
	trigger TEXT NOT NULL,
	queued_at TEXT,
	started_at TEXT,
	completed_at TEXT,
	updated_at TEXT,
	elapsed_ms INTEGER,
	last_error TEXT
);

CREATE TABLE IF NOT EXISTS run_steps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	step_type TEXT NOT NULL,
	label TEXT NOT NULL,
	status TEXT NOT NULL,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	detail_json TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
	id TEXT PRIMARY KEY,
	run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	args_json TEXT NOT NULL,
	result_json TEXT,
	status TEXT NOT NULL,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	error TEXT
);

CREATE TABLE IF NOT EXISTS source_snapshots (
	id TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	title TEXT NOT NULL,
	fetched_at TEXT NOT NULL,
	content_text TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	content_type TEXT,
	status_code INTEGER
);

CREATE TABLE IF NOT EXISTS sources (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
	snapshot_id TEXT REFERENCES source_snapshots(id) ON DELETE SET NULL,
	url TEXT NOT NULL,
	title TEXT NOT NULL,
	fetched_at TEXT NOT NULL,
	snippet TEXT NOT NULL,
	summary TEXT NOT NULL,
	used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reports (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	markdown TEXT NOT NULL,
	created_at TEXT NOT NULL,
	ingest_status TEXT NOT NULL DEFAULT 'not_configured',
	ingest_error TEXT
);

CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	story_id TEXT,
	job_id TEXT,
	run_id TEXT,
	agent TEXT NOT NULL,
	kind TEXT NOT NULL,
	payload_json TEXT NOT NULL DEFAULT '{}',
	sources_json TEXT NOT NULL DEFAULT '[]',
	parent_event_id TEXT,
	cost_metadata_json TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gates (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	story_id TEXT,
	job_id TEXT,
	run_id TEXT,
	type TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open', 'resolved')) DEFAULT 'open',
	priority INTEGER NOT NULL DEFAULT 3,
	payload_json TEXT NOT NULL DEFAULT '{}',
	actions_json TEXT NOT NULL DEFAULT '[]',
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	resolved_at TEXT,
	resolved_by TEXT,
	resolution_action TEXT,
	resolution_notes TEXT,
	resolution_payload_json TEXT,
	resolution_event_id TEXT REFERENCES events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS house_memory (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_entries (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL DEFAULT 'default',
	tier TEXT NOT NULL CHECK (tier IN ('house', 'beat', 'story')),
	scope_id TEXT NOT NULL,
	key TEXT NOT NULL,
	kind TEXT NOT NULL,
	value_json TEXT NOT NULL,
	actor TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
	SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
	SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_no_update
BEFORE UPDATE ON memory_entries
BEGIN
	SELECT RAISE(ABORT, 'memory entries are append-only');
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_no_delete
BEFORE DELETE ON memory_entries
BEGIN
	SELECT RAISE(ABORT, 'memory entries are append-only');
END;
`);
	ensureLegacyWorkspaceColumns(db);

	db.exec(`
CREATE INDEX IF NOT EXISTS runs_job_idx ON runs(job_id, updated_at);
CREATE INDEX IF NOT EXISTS jobs_next_run_idx ON jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS sources_run_idx ON sources(run_id);
CREATE INDEX IF NOT EXISTS reports_job_idx ON reports(job_id, created_at);
CREATE INDEX IF NOT EXISTS events_workspace_created_idx ON events(workspace_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_story_idx ON events(story_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_job_idx ON events(job_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, created_at, id);
CREATE INDEX IF NOT EXISTS gates_queue_idx ON gates(workspace_id, status, priority, created_at, id);
CREATE INDEX IF NOT EXISTS gates_story_idx ON gates(story_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS gates_job_idx ON gates(job_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS memory_entries_scope_idx ON memory_entries(tier, scope_id, created_at, id);
CREATE INDEX IF NOT EXISTS memory_entries_key_idx ON memory_entries(tier, scope_id, key, created_at, id);
CREATE INDEX IF NOT EXISTS memory_entries_workspace_scope_idx ON memory_entries(workspace_id, tier, scope_id, created_at, id);
`);
}

function ensureLegacyWorkspaceColumns(db: HarnessDb): void {
	ensureColumn(db, 'jobs', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
	ensureColumn(db, 'events', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
	ensureColumn(db, 'gates', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
	ensureColumn(db, 'memory_entries', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
}

function ensureColumn(db: HarnessDb, table: string, column: string, definition: string): void {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (columns.some((existing) => existing.name === column)) return;
	db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}
