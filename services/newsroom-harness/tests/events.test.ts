import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { DEFAULT_WORKSPACE_ID, HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
});

describe('newsroom event log', () => {
	it('appends and reads events in created order within a workspace', () => {
		const repo = createRepository();
		const second = repo.appendEvent({
			workspaceId: 'workspace-a',
			storyId: 'story-1',
			agent: 'research',
			kind: 'story.second',
			payload: { ordinal: 2 },
			sources: [{ url: 'https://example.com/two', title: 'Two' }],
			createdAt: '2026-05-24T10:00:02.000Z'
		});
		const first = repo.appendEvent({
			workspaceId: 'workspace-a',
			storyId: 'story-1',
			agent: 'assignment_desk',
			kind: 'story.first',
			payload: { ordinal: 1 },
			createdAt: '2026-05-24T10:00:01.000Z'
		});
		repo.appendEvent({
			workspaceId: 'workspace-b',
			storyId: 'story-1',
			agent: 'assignment_desk',
			kind: 'story.other_workspace',
			createdAt: '2026-05-24T10:00:00.000Z'
		});

		const events = repo.listEvents({ workspaceId: 'workspace-a', storyId: 'story-1' });

		expect(events.map((event) => event.id)).toEqual([first.id, second.id]);
		expect(events.map((event) => event.kind)).toEqual(['story.first', 'story.second']);
		expect(events[0].payload).toEqual({ ordinal: 1 });
		expect(events[1].sources).toEqual([{ url: 'https://example.com/two', title: 'Two' }]);
		expect(repo.listEvents({ workspaceId: 'workspace-b' }).map((event) => event.kind)).toEqual([
			'story.other_workspace'
		]);
		expect(repo.listEvents({ workspaceId: 'workspace-a', afterId: first.id }).map((event) => event.id)).toEqual([
			second.id
		]);
	});

	it('keeps existing events immutable while appending related events', () => {
		const repo = createRepository();
		const handle = requireDb();
		const parent = repo.appendEvent({
			workspaceId: 'workspace-a',
			agent: 'assignment_desk',
			kind: 'story.parent',
			payload: { status: 'started' },
			createdAt: '2026-05-24T10:00:00.000Z'
		});
		const parentSnapshot = repo.requireEvent(parent.id);
		const child = repo.appendEvent({
			workspaceId: 'workspace-a',
			agent: 'research',
			kind: 'story.child',
			parentEventId: parent.id,
			payload: { status: 'continued' },
			createdAt: '2026-05-24T10:00:00.000Z'
		});

		expect(repo.requireEvent(parent.id)).toEqual(parentSnapshot);
		expect(repo.requireEvent(child.id).parent_event_id).toBe(parent.id);
		expect(() => handle.prepare('UPDATE events SET kind = ? WHERE id = ?').run('changed', parent.id)).toThrow(
			/events are append-only/
		);
		expect(() => handle.prepare('DELETE FROM events WHERE id = ?').run(parent.id)).toThrow(
			/events are append-only/
		);
		expect(repo.requireEvent(parent.id)).toEqual(parentSnapshot);
	});

	it('bridges run steps, tool calls, source activity, and reports into event records', () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'Morning Watch',
			prompt: 'Scan local headlines.',
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');

		repo.addRunStep(run.id, 'assignment_desk', 'Route mission to newsroom role');
		const toolId = repo.recordToolCall({
			runId: run.id,
			name: 'configured_source_monitor',
			args: { detail: 'scan fixture' },
			status: 'running'
		});
		repo.updateToolCall(toolId, { status: 'ok', result: { evidenceCount: 1 } });
		repo.storeSource({
			runId: run.id,
			jobId: job.id,
			url: 'https://example.com/local.rss',
			title: 'Local RSS',
			fetchedAt: '2026-05-24T10:00:03.000Z',
			snippet: 'Fixture headline',
			summary: 'Fixture summary',
			used: true,
			contentText: 'Fixture headline body',
			contentHash: 'hash',
			contentType: 'application/rss+xml',
			statusCode: 200
		});
		const report = repo.createReport({
			runId: run.id,
			jobId: job.id,
			title: 'Morning Watch',
			markdown: '# Morning Watch'
		});
		repo.updateReportIngest(report.id, 'sent', null);

		const events = repo.listEvents({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id });

		expect(events.map((event) => event.kind)).toEqual([
			'run.created',
			'run.step',
			'tool.call.started',
			'tool.call.completed',
			'source.stored',
			'report.created',
			'report.ingest.updated'
		]);
		expect(events.every((event) => event.job_id === job.id && event.run_id === run.id)).toBe(true);
		expect(events.find((event) => event.kind === 'source.stored')?.sources).toEqual([
			{
				id: expect.any(String),
				url: 'https://example.com/local.rss',
				title: 'Local RSS',
				fetched_at: '2026-05-24T10:00:03.000Z',
				used: true
			}
		]);
		expect(events.find((event) => event.kind === 'report.created')?.payload).toMatchObject({
			report_id: report.id,
			ingest_status: 'not_configured'
		});
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}

function requireDb(): HarnessDb {
	if (!db) throw new Error('test database is not open');
	return db;
}
