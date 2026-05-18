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
const children = [];
let fixture;
let stopping = false;

async function main() {
	await assertPortFree(8650);
	await assertPortFree(3001);
	await rm(workDir, { recursive: true, force: true });
	await mkdir(logDir, { recursive: true });

	fixture = await startNewsFixture();
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

	startProcess('harness', ['corepack', ['pnpm', '--filter', '@newscraft/newsroom-harness', 'dev']], {
		env: harnessEnv,
		logPath: path.join(logDir, 'harness.log')
	});
	await waitForJson(`${harnessUrl}/health`, { timeoutMs: 45_000 });

	startProcess('ui', ['corepack', ['pnpm', 'dev', '--host', '127.0.0.1', '--port', '3001']], {
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

	const mission = await session.postJson('/api/hermes/jobs', {
		name: `Producer fixture ${Date.now()}`,
		description: 'Acceptance mission against a deterministic local RSS fixture.',
		schedule: 'every 60m',
		prompt: 'Prepare a concise producer brief from the attached local RSS source.',
		deliver: 'database',
		outputFormat: 'markdown',
		sources: [
			{
				id: 'fixture-rss',
				type: 'url',
				name: 'Local fixture RSS',
				url: `${fixture.url}/local-news.rss`,
				enabled: true,
				sortOrder: 0
			}
		]
	});
	const job = mission.job;
	assert(job?.id, 'mission create response did not include a job id');

	await session.postJson(`/api/hermes/jobs/${encodeURIComponent(job.id)}/run`, {});
	const report = await waitForReport(session, job.id);
	for (const section of ['Summary', 'Source Notes', 'Verification Notes', 'Human Review']) {
		assert(report.responseMarkdown.includes(`## ${section}`), `completed report is missing ${section}`);
	}

	const dbReport = await readLatestHarnessReport();
	assert(dbReport.job_id === job.id, 'harness DB report does not match the created mission');
	assert(dbReport.ingest_status === 'sent', `expected UI ingest status sent, got ${dbReport.ingest_status}`);

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
				fixtureUrl: fixture.url,
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

async function startNewsFixture() {
	const server = createServer((req, res) => {
		const base = `http://${req.headers.host}`;
		if (req.url === '/local-news.rss') {
			res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
			res.end(`<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>NewsCraft Producer Fixture</title>
    <item>
      <title>Health desk prepares clinic staffing review</title>
      <link>${base}/health-staffing</link>
      <description>The county health desk published a staffing review note. Producers should verify clinic hours and staffing numbers before broadcast.</description>
    </item>
    <item>
      <title>Transit agency posts storm-delay after-action note</title>
      <link>${base}/transit-after-action</link>
      <description>The transit agency posted a short after-action note about storm delays and said a fuller board packet is due Friday.</description>
    </item>
  </channel>
</rss>`);
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<title>NewsCraft Producer Fixture</title><article>Deterministic local producer fixture article.</article>');
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
