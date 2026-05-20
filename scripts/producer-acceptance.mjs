#!/usr/bin/env node
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { parse as parseDotenv } from 'dotenv';

const root = process.cwd();
const workDir = path.join(root, '.tmp', 'producer-acceptance');
const logDir = path.join(workDir, 'logs');
const uiDbPath = path.join(workDir, 'ui.db');
const harnessDbPath = path.join(workDir, 'harness.db');
const uiUrl = 'http://127.0.0.1:3001';
const harnessUrl = 'http://127.0.0.1:8650';
const password = 'producer acceptance password';
const openAiRequired = process.env.PRODUCER_ACCEPTANCE_REQUIRE_OPENAI !== '0';
const disableOpenAi = process.env.PRODUCER_ACCEPTANCE_DISABLE_OPENAI === '1';
const keepServers = process.env.PRODUCER_ACCEPTANCE_KEEP_SERVERS === '1';
const sourceMode = process.env.PRODUCER_ACCEPTANCE_SOURCE_MODE || 'live-rss';
const children = [];
let fixture;
let stopping = false;

const DEFAULT_LIVE_RSS_SOURCES = [
	{
		id: 'npr-news',
		type: 'url',
		name: 'NPR News',
		url: 'https://feeds.npr.org/1001/rss.xml',
		enabled: true,
		sortOrder: 0
	},
	{
		id: 'bbc-world',
		type: 'url',
		name: 'BBC World',
		url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
		enabled: true,
		sortOrder: 1
	},
	{
		id: 'guardian-world',
		type: 'url',
		name: 'The Guardian World',
		url: 'https://www.theguardian.com/world/rss',
		enabled: true,
		sortOrder: 2
	}
];

async function main() {
	await assertPortFree(8650);
	await assertPortFree(3001);
	await rm(workDir, { recursive: true, force: true });
	await mkdir(logDir, { recursive: true });

	console.log(`Preparing producer acceptance source profile: ${sourceMode}`);
	const sourceProfile = await loadSourceProfile();
	console.log(`Validated ${sourceProfile.sources.length} producer source feed(s).`);
	const rootEnv = await readEnvFile(path.join(root, '.env.local'));
	const harnessFileEnv = await readEnvFile(path.join(root, 'services', 'newsroom-harness', '.env.local'));
	const harnessKey = harnessFileEnv.NEWSROOM_HARNESS_API_KEY || rootEnv.AGENT_GATEWAY_API_KEY || 'producer-acceptance-harness-key';
	const ingestKey = rootEnv.HERMES_INGEST_KEY || rootEnv.HERMES_API_KEY || harnessFileEnv.NEWSROOM_UI_INGEST_KEY || 'producer-acceptance-ingest-key';
	const openAiApiKey = disableOpenAi ? '' : harnessFileEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
	if (openAiRequired && !openAiApiKey) {
		throw new Error('OPENAI_API_KEY is required for producer acceptance. Set PRODUCER_ACCEPTANCE_REQUIRE_OPENAI=0 to run the local fallback path.');
	}

	const harnessEnv = {
		...process.env,
		...harnessFileEnv,
		NEWSROOM_HARNESS_HOST: '127.0.0.1',
		NEWSROOM_HARNESS_PORT: '8650',
		NEWSROOM_HARNESS_DB_PATH: harnessDbPath,
		NEWSROOM_HARNESS_API_KEY: harnessKey,
		NEWSROOM_UI_INGEST_URL: `${uiUrl}/api/hermes/channel-posts`,
		NEWSROOM_UI_INGEST_KEY: ingestKey,
		OPENAI_API_KEY: openAiApiKey
	};
	const uiEnv = {
		...process.env,
		...rootEnv,
		PORT: '3001',
		HOST: '127.0.0.1',
		AGENT_GATEWAY_URL: harnessUrl,
		AGENT_GATEWAY_API_KEY: harnessKey,
		HERMES_INGEST_KEY: ingestKey,
		APP_DB_PATH: uiDbPath,
		APP_PASSWORD_HASH: '',
		APP_SESSION_SECRET:
			rootEnv.APP_SESSION_SECRET ||
			process.env.APP_SESSION_SECRET ||
			'cHJvZHVjZXItYWNjZXB0YW5jZS1zZXNzaW9uLXNlY3JldC0wMDAwMDAwMDA='
	};

	console.log(`Starting newsroom harness at ${harnessUrl}`);
	startProcess('harness', ['pnpm', ['--filter', '@newscraft/newsroom-harness', 'dev']], {
		env: harnessEnv,
		logPath: path.join(logDir, 'harness.log')
	});
	await waitForJson(`${harnessUrl}/health`, { timeoutMs: 45_000 });

	console.log(`Starting SvelteKit UI at ${uiUrl}`);
	startProcess('ui', ['pnpm', ['dev', '--host', '127.0.0.1', '--port', '3001']], {
		env: uiEnv,
		logPath: path.join(logDir, 'ui.log')
	});
	await waitForJson(`${uiUrl}/api/health`, { timeoutMs: 45_000 });

	const harnessHealth = await fetchJson(`${harnessUrl}/health`);
	assert(harnessHealth.ok === true, 'harness health did not return ok:true');
	assert(
		openAiRequired ? harnessHealth.openai?.configured === true : typeof harnessHealth.openai?.configured === 'boolean',
		'harness health did not expose the expected OpenAI configured state'
	);
	const uiHealth = await fetchJson(`${uiUrl}/api/health`);
	assert(uiHealth.gateway?.ok === true, 'UI /api/health did not reach the harness');

	const session = createUiSession(uiUrl);
	await session.setupFirstAccount(password);

	console.log('Creating producer-style mission.');
	const mission = await session.postJson('/api/hermes/jobs', {
		name: `Morning editorial meeting ${Date.now()}`,
		description: sourceProfile.description,
		schedule: 'every 60m',
		prompt: sourceProfile.prompt,
		deliver: 'database',
		outputFormat: 'markdown',
		sources: sourceProfile.sources
	});
	const job = mission.job;
	assert(job?.id, 'mission create response did not include a job id');

	console.log('Running producer mission now.');
	await session.postJson(`/api/hermes/jobs/${encodeURIComponent(job.id)}/run`, {});
	const report = await waitForReport(session, job.id);
	assertProducerReport(report.responseMarkdown, sourceProfile);

	const dbReport = await readLatestHarnessReport();
	assert(dbReport.job_id === job.id, 'harness DB report does not match the created mission');
	assert(dbReport.ingest_status === 'sent', `expected UI ingest status sent, got ${dbReport.ingest_status}`);
	const storedSources = await readHarnessSourcesForRun(dbReport.run_id);
	assertProducerSourcesPersisted(storedSources, sourceProfile);

	await session.postJson(`/api/hermes/jobs/${encodeURIComponent(job.id)}/pause`, {});
	let board = await session.getJson('/api/hermes/board');
	assert(
		board.jobs?.some((candidate) => candidate.id === job.id && candidate.enabled === false),
		'mission did not enter paused state'
	);
	await session.postJson(`/api/hermes/jobs/${encodeURIComponent(job.id)}/resume`, {});
	board = await session.getJson('/api/hermes/board');
	assert(
		board.jobs?.some((candidate) => candidate.id === job.id && candidate.enabled === true),
		'mission did not resume'
	);

	const chat = await session.streamChat('Reply with exactly: Producer smoke OK');
	assert(chat.output.length > 0, 'chat stream returned empty output');
	assert(!chat.hasAdjacentDuplicateChunk, 'chat stream emitted adjacent duplicate text chunks');

	await writeFile(
		path.join(workDir, 'summary.json'),
		JSON.stringify(
			{
				ok: true,
				uiUrl,
				harnessUrl,
				sourceMode: sourceProfile.mode,
				sources: sourceProfile.sources.map(({ name, url }) => ({ name, url })),
				feedProbe: sourceProfile.feedProbe,
				missionId: job.id,
				reportId: report.id,
				harnessReportId: dbReport.id,
				openaiConfigured: harnessHealth.openai?.configured === true,
				logs: {
					ui: path.join(logDir, 'ui.log'),
					harness: path.join(logDir, 'harness.log')
				}
			},
			null,
			2
		)
	);
	console.log(`Producer acceptance passed. Summary: ${path.join(workDir, 'summary.json')}`);
	if (keepServers) {
		console.log(`Keeping acceptance servers running at ${uiUrl} and ${harnessUrl}. Press Ctrl-C to stop them.`);
		await new Promise(() => {});
	}
}

function startProcess(name, [command, args], options) {
	const child = spawn(command, args, {
		cwd: root,
		env: options.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	children.push(child);
	child.stdout.on('data', (chunk) => appendLog(options.logPath, chunk));
	child.stderr.on('data', (chunk) => appendLog(options.logPath, chunk));
	child.on('exit', (code, signal) => {
		if (!stopping && code !== 0) {
			console.error(`${name} exited early with ${signal || code}. See ${options.logPath}`);
		}
	});
	return child;
}

async function appendLog(logPath, chunk) {
	await writeFile(logPath, chunk, { flag: 'a' }).catch(() => undefined);
}

async function readEnvFile(file) {
	if (!existsSync(file)) return {};
	return parseDotenv(await readFile(file));
}

async function assertPortFree(port) {
	await new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once('error', () => reject(new Error(`127.0.0.1:${port} is already in use`)));
		server.once('listening', () => server.close(resolve));
		server.listen(port, '127.0.0.1');
	});
}

async function waitForJson(url, options = {}) {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const started = Date.now();
	let lastError;
	while (Date.now() - started < timeoutMs) {
		try {
			return await fetchJson(url);
		} catch (err) {
			lastError = err;
			await delay(250);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

async function fetchJson(url, init) {
	const response = await fetch(url, init);
	if (!response.ok) throw new Error(`${url} ${response.status}: ${await response.text()}`);
	return response.json();
}

function createUiSession(baseUrl) {
	let cookie = '';
	async function uiFetch(pathname, init = {}) {
		const headers = new Headers(init.headers || {});
		if (cookie) headers.set('cookie', cookie);
		const response = await fetch(new URL(pathname, baseUrl), { ...init, headers });
		rememberCookie(response.headers);
		return response;
	}
	function rememberCookie(headers) {
		const getSetCookie = headers.getSetCookie?.bind(headers);
		const cookies = getSetCookie ? getSetCookie() : headers.get('set-cookie') ? [headers.get('set-cookie')] : [];
		for (const value of cookies) {
			const pair = value.split(';')[0];
			if (pair) cookie = cookie ? `${cookie}; ${pair}` : pair;
		}
	}
	return {
		async setupFirstAccount(nextPassword) {
			const body = new URLSearchParams({ password: nextPassword, confirm: nextPassword });
			const response = await uiFetch('/setup', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
				redirect: 'manual'
			});
			if (![303, 302].includes(response.status)) {
				const text = await response.text();
				const redirectEnvelope = safeJson(text);
				assert(
					response.status === 200 &&
						(redirectEnvelope?.type === 'redirect' || redirectEnvelope?.location === '/'),
					`first account setup failed: ${response.status} ${text}`
				);
			}
			assert(cookie.includes('hermes_sess='), 'first account setup did not return a session cookie');
		},
		async getJson(pathname) {
			const response = await uiFetch(pathname, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
			return response.json();
		},
		async postJson(pathname, body) {
			const response = await uiFetch(pathname, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${await response.text()}`);
			return response.json();
		},
		async streamChat(content) {
			const response = await uiFetch('/api/chat/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify({ content })
			});
			if (!response.ok || !response.body) {
				throw new Error(`chat stream failed: ${response.status} ${await response.text()}`);
			}
			const chunks = [];
			for await (const event of readSse(response.body)) {
				if (event.event !== 'message') continue;
				if (event.data === '[DONE]') break;
				const payload = safeJson(event.data);
				const delta = payload?.choices?.[0]?.delta?.content;
				if (typeof delta === 'string' && delta) chunks.push(delta);
			}
			return {
				output: chunks.join('').trim(),
				hasAdjacentDuplicateChunk: chunks.some((chunk, index) => index > 0 && chunk === chunks[index - 1])
			};
		}
	};
}

async function waitForReport(session, jobId) {
	const started = Date.now();
	while (Date.now() - started < 90_000) {
		const board = await session.getJson('/api/hermes/board');
		const post = board.posts?.find((candidate) => candidate.jobId === jobId && candidate.kind === 'report');
		if (post?.id) {
			const detail = await session.getJson(`/api/hermes/reports/${encodeURIComponent(post.id)}`);
			return { ...post, ...detail };
		}
		await delay(750);
	}
	throw new Error(`Timed out waiting for report for ${jobId}`);
}

async function readLatestHarnessReport() {
	const { default: Database } = await import('better-sqlite3');
	const db = new Database(harnessDbPath, { readonly: true, fileMustExist: true });
	try {
		const row = db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 1').get();
		assert(row, 'harness DB did not persist a report');
		return row;
	} finally {
		db.close();
	}
}

async function readHarnessSourcesForRun(runId) {
	const { default: Database } = await import('better-sqlite3');
	const db = new Database(harnessDbPath, { readonly: true, fileMustExist: true });
	try {
		return db
			.prepare('SELECT url, title, summary, used FROM sources WHERE run_id = ? ORDER BY fetched_at ASC')
			.all(runId);
	} finally {
		db.close();
	}
}

async function* readSse(body) {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let index;
		while ((index = buffer.indexOf('\n\n')) >= 0) {
			const raw = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const event = parseSseEvent(raw);
			if (event) yield event;
		}
	}
	buffer += decoder.decode();
	const event = parseSseEvent(buffer);
	if (event) yield event;
}

function parseSseEvent(raw) {
	if (!raw.trim()) return null;
	let event = 'message';
	const data = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
	}
	return { event, data: data.join('\n') };
}

function safeJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

async function loadSourceProfile() {
	if (sourceMode === 'fixture' || sourceMode === 'local-fixture') {
		fixture = await startNewsFixture();
		const sources = [
			{
				id: 'local-wire-rss',
				type: 'url',
				name: 'Local newsroom wire',
				url: `${fixture.url}/local-news.rss`,
				enabled: true,
				sortOrder: 0
			}
		];
		return {
			mode: 'fixture',
			description: 'Producer acceptance against a deterministic local newsroom RSS feed.',
			sources,
			prompt: producerMissionPrompt(sources),
			feedProbe: []
		};
	}

	if (sourceMode !== 'live-rss') {
		throw new Error(`Unsupported PRODUCER_ACCEPTANCE_SOURCE_MODE=${sourceMode}. Use live-rss or fixture.`);
	}

	const sources = customLiveSourcesFromEnv() || DEFAULT_LIVE_RSS_SOURCES;
	assert(sources.length > 0, 'No producer RSS feeds configured');
	const feedProbe = await assertReadableFeeds(sources);
	return {
		mode: 'live-rss',
		description: 'Producer acceptance against live public RSS feeds used as real editorial inputs.',
		sources,
		prompt: producerMissionPrompt(sources),
		feedProbe
	};
}

function customLiveSourcesFromEnv() {
	const raw = process.env.PRODUCER_ACCEPTANCE_FEEDS?.trim();
	if (!raw) return null;
	const sources = raw
		.split(',')
		.map((url, index) => {
			const trimmed = url.trim();
			if (!trimmed) return null;
			const host = new URL(trimmed).hostname.replace(/^www\./, '');
			return {
				id: `producer-feed-${index + 1}`,
				type: 'url',
				name: `Producer feed ${index + 1} (${host})`,
				url: trimmed,
				enabled: true,
				sortOrder: index
			};
		})
		.filter(Boolean);
	return sources.length ? sources : null;
}

function producerMissionPrompt(sources) {
	const sourceNames = sources.map((source) => source.name).join(', ');
	return `You are the assignment producer preparing the next NewsCraft editorial meeting brief.

Use the attached RSS feeds (${sourceNames}) as live inputs. Answer the questions a producer would actually ask before assigning coverage:
- What are the strongest lead candidates right now?
- Why would our audience care today?
- What facts are confirmed by the feed text, and what still needs a call, document, or second source?
- What source notes should an editor see before approving the assignment?
- What should remain blocked from publishing until a human reviews it?

Write in plain newsroom language, not implementation language. Do not mention harnesses, APIs, SDKs, tests, fixtures, or databases. Do not invent facts beyond the feed text. Output markdown with these sections exactly:
## Summary
## Lead Candidates
## Source Notes
## Verification Notes
## Human Review`;
}

async function assertReadableFeeds(sources) {
	const probes = [];
	for (const source of sources) {
		console.log(`Checking producer RSS feed: ${source.name} (${source.url})`);
		try {
			const response = await fetch(source.url, {
				headers: { 'user-agent': 'NewsCraft producer-acceptance/0.0.1 (+https://newscraft.ai)' },
				signal: AbortSignal.timeout(20_000)
			});
			const body = await response.text();
			assert(response.ok, `${source.name} feed returned ${response.status}`);
			assert(
				/<(rss|feed|item|entry)\b/i.test(body.slice(0, 8000)),
				`${source.name} did not look like an RSS or Atom feed`
			);
			probes.push({
				name: source.name,
				url: source.url,
				status: response.status,
				contentType: response.headers.get('content-type'),
				itemCount: (body.match(/<(item|entry)\b/gi) || []).length
			});
		} catch (err) {
			throw new Error(`${source.name} feed check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return probes;
}

function assertProducerReport(markdown, sourceProfile) {
	for (const section of ['Summary', 'Lead Candidates', 'Source Notes', 'Verification Notes', 'Human Review']) {
		assert(new RegExp(`^##\\s+${section}\\s*$`, 'im').test(markdown), `completed report is missing ${section}`);
	}

	const checks = [
		[/lead candidate|lead-worthy|lead story|top story|strongest/i, 'lead candidates'],
		[/audience|why it matters|public impact|viewers|readers/i, 'audience relevance'],
		[/verify|confirm|corroborate|second source|primary source|before publishing/i, 'verification work'],
		[/human review|editor|producer|approval|do not publish|blocked from publishing/i, 'human editorial approval']
	];
	for (const [pattern, label] of checks) {
		assert(pattern.test(markdown), `producer report does not discuss ${label}`);
	}

	const lowerMarkdown = markdown.toLowerCase();
	const sourceMentions = sourceProfile.sources.filter((source) => {
		const host = new URL(source.url).hostname.replace(/^www\./, '');
		const shortName = source.name.split(/\s+/)[0]?.toLowerCase();
		return (
			lowerMarkdown.includes(source.name.toLowerCase()) ||
			(shortName && lowerMarkdown.includes(shortName)) ||
			lowerMarkdown.includes(host.toLowerCase()) ||
			lowerMarkdown.includes(source.url.toLowerCase())
		);
	});
	assert(
		sourceMentions.length >= Math.min(2, sourceProfile.sources.length),
		`producer report only mentions ${sourceMentions.length} configured source(s)`
	);
	assert(
		!/harness|SDK|database|fixture|test account/i.test(markdown),
		'producer report leaked implementation language into the editor-facing brief'
	);
	assert(
		!/No structured|No lead candidates were ranked|No external source URLs/i.test(markdown),
		'producer report fell back to missing-content boilerplate'
	);
}

function assertProducerSourcesPersisted(storedSources, sourceProfile) {
	const expectedUrls = sourceProfile.sources.map((source) => source.url);
	for (const url of expectedUrls) {
		assert(
			storedSources.some((source) => source.url === url && source.used === 1),
			`harness DB did not persist used source ${url}`
		);
	}
}

async function startNewsFixture() {
	const server = createServer((req, res) => {
		const base = `http://${req.headers.host}`;
		if (req.url === '/local-news.rss') {
			res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
			res.end(`<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>NewsCraft Local Newsroom Wire</title>
    <item>
      <title>City council schedules emergency budget hearing</title>
      <link>${base}/budget-hearing</link>
      <description>Council leaders scheduled an emergency hearing after a revised finance memo projected a transit funding gap. Producers should confirm the agenda, dollar figure, and public comment window.</description>
    </item>
    <item>
      <title>Hospital network reports overnight emergency room diversion</title>
      <link>${base}/hospital-diversion</link>
      <description>The regional hospital network said two emergency departments diverted ambulances overnight because of staffing pressure. Producers should call the hospitals and emergency services before assigning a live update.</description>
    </item>
  </channel>
</rss>`);
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<title>NewsCraft Producer Wire</title><article>Deterministic local producer source article.</article>');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
	stopping = true;
	await fixture?.close().catch(() => undefined);
	for (const child of children.reverse()) {
		if (child.exitCode !== null || child.signalCode) continue;
		killChildGroup(child, 'SIGTERM');
		await Promise.race([
			new Promise((resolve) => child.once('exit', resolve)),
			delay(5000).then(() => killChildGroup(child, 'SIGKILL'))
		]).catch(() => undefined);
	}
}

function killChildGroup(child, signal) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			/* already exited */
		}
	}
}

process.on('SIGINT', () => cleanup().finally(() => process.exit(130)));
process.on('SIGTERM', () => cleanup().finally(() => process.exit(143)));

main()
	.catch(async (err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	})
	.finally(cleanup);
