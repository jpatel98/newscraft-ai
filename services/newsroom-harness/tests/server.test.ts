import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarnessServer, type HarnessServer } from '../src/server.js';

let tempDir: string;
let harness: HarnessServer;

async function startHarness(config: Parameters<typeof createHarnessServer>[0]['config'] = {}) {
	tempDir = await mkdtemp(path.join(tmpdir(), 'newsroom-harness-'));
	harness = createHarnessServer({
		startScheduler: false,
		config: {
			dbPath: path.join(tempDir, 'harness.db'),
			apiKey: 'secret',
			openAiApiKey: '',
			schedulerIntervalMs: 100,
			runTimeoutMs: 5000,
			...config
		}
	});
	await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve));
	return harness.url();
}

async function authFetch(pathname: string, init: RequestInit = {}) {
	return fetch(`${harness.url()}${pathname}`, {
		...init,
		headers: {
			authorization: 'Bearer secret',
			...(init.headers || {})
		}
	});
}

afterEach(async () => {
	await harness?.close();
	if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('newsroom harness server', () => {
	it('serves health without auth', async () => {
		const base = await startHarness();
		const response = await fetch(`${base}/health`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			service: 'newsroom-harness',
			openai: { configured: false },
			db: { ok: true },
			scheduler: { running: false, intervalMs: 100 },
			ingest: { configured: false },
			limits: { runTimeoutMs: 5000 }
		});
	});

	it('requires bearer auth on non-health endpoints when configured', async () => {
		const base = await startHarness();
		const unauthorized = await fetch(`${base}/api/jobs`);
		const authorized = await authFetch('/api/jobs');

		expect(unauthorized.status).toBe(401);
		expect(authorized.status).toBe(200);
		await expect(authorized.json()).resolves.toMatchObject({ jobs: [] });
	});

	it('serves the authenticated event feed', async () => {
		await startHarness();
		const event = harness.repository.appendEvent({
			workspaceId: 'workspace-api',
			storyId: 'story-api',
			agent: 'assignment_desk',
			kind: 'story.note',
			payload: { note: 'ready' },
			createdAt: '2026-05-24T10:00:00.000Z'
		});

		const response = await authFetch('/api/events?workspace_id=workspace-api&story_id=story-api');
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.events).toHaveLength(1);
		expect(body.events[0]).toMatchObject({
			id: event.id,
			workspace_id: 'workspace-api',
			story_id: 'story-api',
			agent: 'assignment_desk',
			kind: 'story.note',
			payload: { note: 'ready' }
		});
	});

	it('serves authenticated memory inspect and write endpoints', async () => {
		await startHarness();

		harness.repository.appendEvent({
			workspaceId: 'workspace-api',
			storyId: 'story-api',
			agent: 'research',
			kind: 'claim.proposed',
			payload: { claim: 'Council meets Monday' }
		});
		const storyAppend = await authFetch('/api/memory/stories/story-api?workspace_id=workspace-api', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				key: 'fact_ledger',
				value: { claim: 'Council meets Monday', status: 'checking' },
				actor: 'research'
			})
		});
		const storyInspect = await authFetch('/api/memory/stories/story-api/inspect?workspace_id=workspace-api');

		expect(storyAppend.status).toBe(201);
		const story = (await storyInspect.json()).memory;
		expect(story.current.fact_ledger).toEqual([{ claim: 'Council meets Monday', status: 'checking' }]);
		expect(story.agent_event_log.map((event: { kind: string }) => event.kind)).toEqual(['claim.proposed']);
	});

	it('streams Chat Completions-compatible SSE frames', async () => {
		await startHarness();
		const response = await authFetch('/v1/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				stream: true,
				messages: [{ role: 'user', content: 'Summarize https://example.com' }]
			})
		});
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		expect(text).toContain('"object":"chat.completion.chunk"');
		expect(text.trim().endsWith('data: [DONE]')).toBe(true);
	});

	it('returns non-streaming Chat Completions JSON for title generation', async () => {
		await startHarness();
		const response = await authFetch('/v1/chat/completions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				stream: false,
				messages: [{ role: 'user', content: 'Title for this conversation:' }]
			})
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.object).toBe('chat.completion');
		expect(body.choices[0].message.content).toContain('NewsCraft');
	});

	it('creates, updates, pauses, resumes, lists, and deletes jobs', async () => {
		await startHarness();
		const created = await createJob();
		expect(created.name).toBe('Morning Watch');

		const updatedResponse = await authFetch(`/api/jobs/${created.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Updated Watch', enabled: false })
		});
		const updated = (await updatedResponse.json()).job;
		expect(updated.name).toBe('Updated Watch');
		expect(updated.enabled).toBe(false);

		const resumed = await authFetch(`/api/jobs/${created.id}/resume`, { method: 'POST' });
		expect((await resumed.json()).job.enabled).toBe(true);

		const paused = await authFetch(`/api/jobs/${created.id}/pause`, { method: 'POST' });
		expect((await paused.json()).job.enabled).toBe(false);

		const deleted = await authFetch(`/api/jobs/${created.id}`, { method: 'DELETE' });
		expect(deleted.status).toBe(200);
		expect((await (await authFetch('/api/jobs?include_disabled=true')).json()).jobs).toHaveLength(0);
	});

	it('filters run listing by job ids', async () => {
		await startHarness();
		const first = harness.repository.createJob({
			name: 'First Watch',
			prompt: 'Scan first beat.',
			schedule: 'every 60m'
		});
		const second = harness.repository.createJob({
			name: 'Second Watch',
			prompt: 'Scan second beat.',
			schedule: 'every 60m'
		});
		const firstRun = harness.repository.createRun(first.id, 'test');
		harness.repository.createRun(second.id, 'test');

		const response = await authFetch(`/api/runs?include_completed=true&job_ids=${first.id}`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.runs.map((run: { id: string }) => run.id)).toEqual([firstRun.id]);
	});

	it('lists saved reports by job ids', async () => {
		await startHarness();
		const first = harness.repository.createJob({
			name: 'First Watch',
			prompt: 'Scan first beat.',
			schedule: 'every 60m'
		});
		const second = harness.repository.createJob({
			name: 'Second Watch',
			prompt: 'Scan second beat.',
			schedule: 'every 60m'
		});
		const firstRun = harness.repository.createRun(first.id, 'test');
		const secondRun = harness.repository.createRun(second.id, 'test');
			const firstReport = harness.repository.createReport({
				runId: firstRun.id,
				jobId: first.id,
				title: first.name,
				markdown: '# Research Update: First Watch\n\n**Story ID:** first\n\n## Update\n\nFirst output'
			});
			harness.repository.createReport({
				runId: secondRun.id,
				jobId: second.id,
				title: second.name,
				markdown: '# Research Update: Second Watch\n\n**Story ID:** second\n\n## Update\n\nSecond output'
			});

		const response = await authFetch(`/api/reports?job_ids=${first.id}`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.reports.map((report: { id: string }) => report.id)).toEqual([firstReport.id]);
		expect(body.reports[0].markdown).toContain('First output');
	});

	it('runs story research, persists an update, and posts the UI ingest payload shape', async () => {
		const received: unknown[] = [];
		const ingest = await startIngestServer(received);
		const fixture = await startNewsFixtureServer();
		await startHarness({
			uiIngestUrl: `${ingest.url}/api/agent/channel-posts`,
			uiIngestKey: 'ingest-key'
		});
		const job = await createJob({
			prompt: `Find recent local coverage from this RSS fixture and write a concise research update with source links: ${fixture.url}/local-news.rss`
		});

		const runResponse = await authFetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
		expect(runResponse.status).toBe(202);
		const run = (await runResponse.json()).run;

		await waitFor(async () => {
			const runs = (await (await authFetch('/api/runs?include_completed=true&include_recent=true')).json()).runs;
			return runs.find((candidate: { id: string; status: string }) => candidate.id === run.id)?.status === 'completed';
		});

		const reports = harness.repository.listReports();
		expect(reports).toHaveLength(1);
		expect(reports[0].markdown).toContain('# Research Update: Morning Watch');
		expect(reports[0].markdown).toContain('## Update');
		expect(reports[0].markdown).toMatch(/City desk confirms river inspection|Transit board advances late train review/i);
		expect(reports[0].markdown).not.toMatch(/SDK|database|test account/i);
		expect(reports[0].ingest_status).toBe('sent');
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			id: reports[0].id,
			jobId: job.id,
			channel: 'Morning Watch',
			schedule: 'every 60m'
		});
		expect(String((received[0] as { filePathDisplay: string }).filePathDisplay)).toMatch(
			new RegExp(`^${job.id}/`)
		);
		expect(String((received[0] as { markdown: string }).markdown)).toContain('## Update');
		expect(harness.repository.listSourcesForRun(run.id).map((source) => source.url)).toContain(
			`${fixture.url}/local-news.rss`
		);
		await ingest.close();
		await fixture.close();
	});
});

async function createJob(overrides: Record<string, unknown> = {}) {
	const response = await authFetch('/api/jobs', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			name: 'Morning Watch',
			schedule: 'every 60m',
			prompt: 'Scan the latest local headlines.',
			deliver: 'database',
			...overrides
		})
	});
	expect(response.status).toBe(201);
	return (await response.json()).job;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('timed out waiting for condition');
}

async function startIngestServer(received: unknown[]): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
		req.on('end', () => {
			received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
}

async function startNewsFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		const base = `http://${req.headers.host}`;
		if (req.url === '/local-news.rss') {
			res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
			res.end(`<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>NewsCraft Local Fixture</title>
    <item>
      <title>City desk confirms river inspection</title>
      <link>${base}/river-inspection</link>
      <description>Officials scheduled a levee inspection after overnight rain. Editors should verify timing with the public works office.</description>
    </item>
    <item>
      <title>Transit board advances late train review</title>
      <link>${base}/transit-review</link>
      <description>The board requested a short operational review and a rider impact note before the next meeting.</description>
    </item>
  </channel>
</rss>`);
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<title>NewsCraft Local Fixture</title><p>Local fixture article for producer acceptance.</p>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
}
