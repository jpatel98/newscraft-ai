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
		const workspaceId = 'account:editor-1';
		const job = repo.createJob({
			workspace_id: workspaceId,
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

		const events = repo.listEvents({ workspaceId, runId: run.id });

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
		expect(repo.listEvents({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id })).toHaveLength(0);
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

	it('surfaces source-health gates as source monitor events', () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'Source Health',
			prompt: 'Check source reliability.',
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');

		repo.storeSource({
			runId: run.id,
			jobId: job.id,
			url: 'https://example.com/flaky',
			title: 'Flaky source',
			fetchedAt: '2026-05-24T10:00:03.000Z',
			snippet: '',
			summary: '',
			used: false,
			contentText: '',
			contentHash: 'hash',
			contentType: 'text/plain',
			statusCode: 503,
			healthGate: {
				type: 'source_health',
				url: 'https://example.com/flaky',
				host: 'example.com',
				statusCode: 503,
				reason: 'HTTP 503',
				failureCount: 3,
				failureBudget: 3
			}
		});

		const events = repo.listEvents({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id });

		expect(events.map((event) => event.kind)).toEqual([
			'run.created',
			'source.stored',
			'source.health.gate',
			'gate.queued'
		]);
		expect(events.find((event) => event.kind === 'source.health.gate')?.payload).toMatchObject({
			type: 'source_health',
			host: 'example.com',
			reason: 'HTTP 503'
		});
		expect(repo.listGates({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id })[0]).toMatchObject({
			type: 'source_health',
			actions: ['pause', 'retry', 'drop', 'override'],
			payload: expect.objectContaining({
				host: 'example.com',
				source: expect.objectContaining({
					url: 'https://example.com/flaky'
				})
			})
		});
	});

	it('does not duplicate open Source Health gates for the same host', () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'Source Health',
			prompt: 'Check source reliability.',
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');
		const source = {
			runId: run.id,
			jobId: job.id,
			url: 'https://example.com/flaky',
			title: 'Flaky source',
			fetchedAt: '2026-05-24T10:00:03.000Z',
			snippet: '',
			summary: '',
			used: false,
			contentText: '',
			contentHash: 'hash',
			contentType: 'text/plain',
			statusCode: 503,
			healthGate: {
				type: 'source_health',
				url: 'https://example.com/flaky',
				host: 'example.com',
				statusCode: 503,
				reason: 'HTTP 503',
				failureCount: 3,
				failureBudget: 3
			}
		};

		repo.storeSource(source);
		repo.storeSource({ ...source, contentHash: 'hash-2', url: 'https://example.com/other-flaky' });

		expect(repo.listGates({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id })).toHaveLength(1);
		expect(repo.listEvents({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id }).filter((event) => event.kind === 'gate.queued')).toHaveLength(1);
		expect(
			repo.listEvents({ workspaceId: DEFAULT_WORKSPACE_ID, runId: run.id }).filter((event) => event.kind === 'source.health.gate')
		).toHaveLength(1);
	});

	it('preserves extraction metadata and provenance on stored source events', () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'Source Metadata',
			prompt: 'Read a source.',
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');

		repo.storeSource({
			runId: run.id,
			jobId: job.id,
			url: 'https://example.com/story',
			title: 'Story title',
			fetchedAt: '2026-05-24T10:00:03.000Z',
			snippet: 'Story snippet',
			summary: 'Story summary',
			used: true,
			contentText: 'Story body',
			contentHash: 'hash',
			contentType: 'text/html',
			statusCode: 200,
			metadata: {
				structuredType: 'NewsArticle',
				metadataSources: ['json_ld']
			},
			provenance: {
				adapter: 'html_article',
				extractionMethod: 'json_ld_article_body',
				metadataSources: ['json_ld'],
				structuredType: 'NewsArticle'
			}
		});

		const event = repo.listEvents({ runId: run.id }).find((candidate) => candidate.kind === 'source.stored');
		expect(event?.payload).toMatchObject({
			metadata: {
				structuredType: 'NewsArticle',
				metadataSources: ['json_ld']
			},
			provenance: {
				extractionMethod: 'json_ld_article_body',
				structuredType: 'NewsArticle'
			}
		});
		expect(event?.sources[0]).toMatchObject({
			metadata: {
				structuredType: 'NewsArticle'
			},
			provenance: {
				extractionMethod: 'json_ld_article_body'
			}
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
