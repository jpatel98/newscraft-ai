import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type HarnessDb } from '../src/db/database.js';

let tempDir: string | null = null;
let db: HarnessDb | null = null;

afterEach(async () => {
	db?.close();
	db = null;
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
	tempDir = null;
});

describe('harness database schema', () => {
	it('migrates legacy workspace-unscoped tables before creating dependent indexes', async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), 'newsroom-harness-db-'));
		const dbPath = path.join(tempDir, 'harness.db');
		createLegacyWorkspaceUnscopedDatabase(dbPath);

		db = openDatabase(dbPath);

		expect(columnsFor(db, 'jobs')).toContain('workspace_id');
		expect(columnsFor(db, 'events')).toContain('workspace_id');
		expect(columnsFor(db, 'gates')).toContain('workspace_id');
		expect(columnsFor(db, 'memory_entries')).toContain('workspace_id');
		expect(workspaceIdFor(db, 'jobs', 'job-legacy')).toBe('default');
		expect(workspaceIdFor(db, 'events', 'event-legacy')).toBe('default');
		expect(workspaceIdFor(db, 'gates', 'gate-legacy')).toBe('default');
		expect(workspaceIdFor(db, 'memory_entries', 'memory-legacy')).toBe('default');
	});

	it('re-opens an already-migrated legacy database without error and preserves rows', async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), 'newsroom-harness-db-'));
		const dbPath = path.join(tempDir, 'harness.db');
		createLegacyWorkspaceUnscopedDatabase(dbPath);

		openDatabase(dbPath).close();
		db = openDatabase(dbPath);

		for (const table of ['jobs', 'events', 'gates', 'memory_entries']) {
			expect(columnsFor(db, table).filter((column) => column === 'workspace_id')).toHaveLength(1);
		}
		expect(workspaceIdFor(db, 'jobs', 'job-legacy')).toBe('default');
		expect(workspaceIdFor(db, 'events', 'event-legacy')).toBe('default');
		expect(workspaceIdFor(db, 'gates', 'gate-legacy')).toBe('default');
		expect(workspaceIdFor(db, 'memory_entries', 'memory-legacy')).toBe('default');
	});
});

function createLegacyWorkspaceUnscopedDatabase(dbPath: string): void {
	const legacy = new Database(dbPath);
	try {
		legacy.exec(`
CREATE TABLE jobs (
	id TEXT PRIMARY KEY,
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

CREATE TABLE events (
	id TEXT PRIMARY KEY,
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

CREATE TABLE gates (
	id TEXT PRIMARY KEY,
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
	resolution_event_id TEXT
);

CREATE TABLE memory_entries (
	id TEXT PRIMARY KEY,
	tier TEXT NOT NULL CHECK (tier IN ('house', 'beat', 'story')),
	scope_id TEXT NOT NULL,
	key TEXT NOT NULL,
	kind TEXT NOT NULL,
	value_json TEXT NOT NULL,
	actor TEXT NOT NULL,
	created_at TEXT NOT NULL
);

INSERT INTO jobs (
	id, name, prompt, schedule, created_at, updated_at
) VALUES (
	'job-legacy', 'Legacy job', 'Scan sources.', 'every 60m', '2026-05-29T10:00:00.000Z', '2026-05-29T10:00:00.000Z'
);
INSERT INTO events (
	id, agent, kind, created_at
) VALUES (
	'event-legacy', 'assignment_desk', 'story.created', '2026-05-29T10:00:00.000Z'
);
INSERT INTO gates (
	id, type, title, summary, created_by, created_at
) VALUES (
	'gate-legacy', 'source_health', 'Source needs review', 'Legacy gate.', 'monitor', '2026-05-29T10:00:00.000Z'
);
INSERT INTO memory_entries (
	id, tier, scope_id, key, kind, value_json, actor, created_at
) VALUES (
	'memory-legacy', 'story', 'story-legacy', 'fact_ledger', 'json', '{}', 'research', '2026-05-29T10:00:00.000Z'
);
`);
	} finally {
		legacy.close();
	}
}

function columnsFor(handle: HarnessDb, table: string): string[] {
	return (handle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
		(column) => column.name
	);
}

function workspaceIdFor(handle: HarnessDb, table: string, id: string): string {
	return (handle.prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`).get(id) as { workspace_id: string })
		.workspace_id;
}
