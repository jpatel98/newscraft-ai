import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.APP_DB_PATH;
let tempDir: string | null = null;
let closeDb: (() => void) | null = null;

async function loadIsolatedDb() {
	vi.resetModules();
	tempDir = await mkdtemp(path.join(tmpdir(), 'hermes-ui-db-'));
	process.env.APP_DB_PATH = path.join(tempDir, 'app.db');
	vi.doMock('$env/dynamic/private', () => ({ env: process.env }));
	const dbModule = await import('./index');
	closeDb = () => dbModule.sqliteClient.close();
	dbModule.sqliteClient.exec(`
		CREATE TABLE mission_reports (
			id text PRIMARY KEY NOT NULL,
			account_id text NOT NULL,
			mission_id text NOT NULL,
			mission_name text NOT NULL,
			run_time text,
			schedule text,
			filename text NOT NULL,
			file_path_display text NOT NULL,
			output_format text DEFAULT 'markdown' NOT NULL,
			response_markdown text NOT NULL,
			preview text NOT NULL,
			source_mtime_ms integer DEFAULT 0 NOT NULL,
			legacy_channel_post_id text,
			created_at integer NOT NULL,
			updated_at integer NOT NULL
		);
		CREATE TABLE hermes_channel_posts (
			id text PRIMARY KEY NOT NULL,
			account_id text NOT NULL,
			job_id text NOT NULL,
			channel text NOT NULL,
			run_time text,
			schedule text,
			filename text NOT NULL,
			file_path_display text NOT NULL,
			response_markdown text NOT NULL,
			preview text NOT NULL,
			source_mtime_ms integer DEFAULT 0 NOT NULL,
			created_at integer NOT NULL,
			updated_at integer NOT NULL
		);
	`);
	return import('./mission-reports');
}

describe('mission report queries', () => {
	beforeEach(() => {
		closeDb = null;
		tempDir = null;
	});

	afterEach(async () => {
		closeDb?.();
		closeDb = null;
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		tempDir = null;
		if (originalDbPath === undefined) delete process.env.APP_DB_PATH;
		else process.env.APP_DB_PATH = originalDbPath;
		vi.resetModules();
	});

	it('lists report summaries without loading response markdown and fetches detail by id', async () => {
		const reports = await loadIsolatedDb();
		reports.upsertMissionReport({
			id: 'report-1',
			accountId: 'acct-1',
			missionId: 'mission-1',
			missionName: 'Morning scan',
			runTime: '2026-05-12T01:00:00.000Z',
			schedule: 'hourly',
			filename: '2026-05-12_01-00-00.md',
			filePathDisplay: 'mission-1/2026-05-12_01-00-00.md',
			responseMarkdown: '# Full report\n\nThis body can be large.',
			preview: 'Full report',
			sourceMtimeMs: 123
		});

		const summaries = reports.listMissionReportSummaries('acct-1');
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			id: 'report-1',
			missionId: 'mission-1',
			missionName: 'Morning scan',
			responseMarkdown: ''
		});

		const detail = reports.getMissionReport('acct-1', 'report-1');
		expect(detail?.responseMarkdown).toContain('This body can be large.');
		expect(reports.getMissionReport('acct-2', 'report-1')).toBeUndefined();
	});
});
