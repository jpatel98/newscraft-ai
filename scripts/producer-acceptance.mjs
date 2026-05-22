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
const harnessDbPath = path.join(workDir, 'harness.db');
const uiUrl = 'http://127.0.0.1:3001';
const harnessUrl = 'http://127.0.0.1:8650';
const password = process.env.PRODUCER_ACCEPTANCE_PASSWORD || 'HelloWorld@123';
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

const COMPETITOR_FIXTURE_OUTLETS = [
	{
		slug: 'cbc-politics',
		sourceName: 'CBC Politics',
		sourceId: 'fixture-cbc-politics',
		title: 'CBC Politics - Federal byelection finance pledge leads morning politics coverage',
		items: [
			{
				id: 'federal-byelection-finance-pledge',
				title: 'CBC leads with federal byelection finance pledge and voter-cost framing',
				description:
					'CBC Politics leads the competitor coverage with the federal finance minister promising a targeted affordability credit during the Ottawa Centre byelection. Compared with CTV and Global, CBC emphasizes voter cost-of-living stakes, the minister quote, and the opposition demand for a fiscal table before air.'
			},
			{
				id: 'ethics-committee-follow',
				title: 'CBC follows committee ethics hearing with document gap noted',
				description:
					'CBC Politics says the ethics committee hearing is a secondary angle and flags that producers still need the full witness list and the official committee notice.'
			}
		]
	},
	{
		slug: 'ctv-politics',
		sourceName: 'CTV Politics',
		sourceId: 'fixture-ctv-politics',
		title: 'CTV Politics - Campaign strategy and reaction shape rival coverage',
		items: [
			{
				id: 'campaign-strategy-reaction',
				title: 'CTV frames the finance pledge as campaign strategy with party reaction',
				description:
					'CTV Politics covers the same federal finance pledge but frames it through campaign strategy, party reaction, and the question of whether the promise changes the byelection map. While CBC leads with household costs, CTV foregrounds Conservative and NDP reaction and asks for confirmation from Elections Canada.'
			},
			{
				id: 'leaders-scrum',
				title: 'CTV notes leaders scrum could move the story after question period',
				description:
					'CTV Politics says producers should watch the afternoon leaders scrum because the story may shift if the prime minister or opposition leader commits to a new fiscal document.'
			}
		]
	},
	{
		slug: 'global-politics',
		sourceName: 'Global Politics',
		sourceId: 'fixture-global-politics',
		title: 'Global Politics - Regional impact and verification needs drive coverage',
		items: [
			{
				id: 'regional-impact-verification',
				title: 'Global spotlights regional impact and verification gaps in federal pledge',
				description:
					'Global Politics also reports on the federal finance pledge, but its coverage angle is regional impact outside Ottawa and what provincial officials say about delivery. Unlike CBC and CTV, Global stresses that producers should verify eligibility numbers, implementation timing, and whether provinces have been briefed.'
			},
			{
				id: 'provincial-ministers-response',
				title: 'Global tracks provincial ministers response to federal affordability promise',
				description:
					'Global Politics says the comparative coverage gap is whether provincial ministers confirm consultation before the federal pledge becomes a publishable assignment.'
			}
		]
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
	const uiDatabaseUrl = process.env.PRODUCER_ACCEPTANCE_DATABASE_URL || rootEnv.PRODUCER_ACCEPTANCE_DATABASE_URL || process.env.DATABASE_URL || rootEnv.DATABASE_URL || '';
	const openAiApiKey = disableOpenAi ? '' : harnessFileEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
	if (openAiRequired && !openAiApiKey) {
		throw new Error('OPENAI_API_KEY is required for producer acceptance. Set PRODUCER_ACCEPTANCE_REQUIRE_OPENAI=0 to run the local fallback path.');
	}
	if (!uiDatabaseUrl) {
		throw new Error('DATABASE_URL or PRODUCER_ACCEPTANCE_DATABASE_URL is required for the SvelteKit app.');
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
		DATABASE_URL: uiDatabaseUrl,
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
	assertProducerProgress(report.producerProgress, sourceProfile);
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
	async function loginWithPassword(nextPassword) {
		const response = await uiFetch('/login', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ password: nextPassword }),
			redirect: 'manual'
		});
		if (![303, 302].includes(response.status)) {
			const text = await response.text();
			const redirectEnvelope = safeJson(text);
			assert(
				response.status === 200 &&
					(redirectEnvelope?.type === 'redirect' || redirectEnvelope?.location === '/'),
				`login fallback failed: ${response.status} ${text}`
			);
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
			if (!cookie.includes('hermes_sess=')) await loginWithPassword(nextPassword);
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
	const progress = {
		boardPolls: 0,
		reportSeen: false,
		runStatuses: new Set(),
		sourceCounts: [],
		stepLabels: new Set(),
		toolNames: new Set(),
		latestRun: null
	};
	while (Date.now() - started < 90_000) {
		const board = await session.getJson('/api/hermes/board');
		recordBoardProgress(progress, board, jobId);
		const post = board.posts?.find((candidate) => candidate.jobId === jobId && candidate.kind === 'report');
		if (post?.id) {
			progress.reportSeen = true;
			const detail = await session.getJson(`/api/hermes/reports/${encodeURIComponent(post.id)}`);
			return { ...post, ...detail, producerProgress: progress };
		}
		await delay(750);
	}
	throw new Error(`Timed out waiting for report for ${jobId}`);
}

function recordBoardProgress(progress, board, jobId) {
	progress.boardPolls += 1;
	const runs = (board.runs || []).filter((run) => run.jobId === jobId);
	for (const run of runs) {
		if (run.status) progress.runStatuses.add(run.status);
		if (typeof run.sourceCount === 'number') progress.sourceCounts.push(run.sourceCount);
		for (const step of run.steps || []) {
			if (step.label) progress.stepLabels.add(step.label);
		}
		for (const tool of run.toolCalls || []) {
			if (tool.name) progress.toolNames.add(tool.name);
		}
		progress.latestRun = run;
	}
	const channel = board.channels?.find((candidate) => candidate.jobId === jobId);
	for (const run of [channel?.activeRun, channel?.recentRun].filter(Boolean)) {
		if (run.status) progress.runStatuses.add(run.status);
		if (typeof run.sourceCount === 'number') progress.sourceCounts.push(run.sourceCount);
		for (const step of run.steps || []) {
			if (step.label) progress.stepLabels.add(step.label);
		}
		for (const tool of run.toolCalls || []) {
			if (tool.name) progress.toolNames.add(tool.name);
		}
		progress.latestRun = run;
	}
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
		fixture = await startCompetitorCoverageFixture();
		const sources = COMPETITOR_FIXTURE_OUTLETS.map((outlet, index) => ({
			id: outlet.sourceId,
			type: 'url',
			name: outlet.sourceName,
			url: `${fixture.url}/${outlet.slug}.rss`,
			enabled: true,
			sortOrder: index
		}));
		return {
			mode: 'fixture',
			description:
				'Producer acceptance against deterministic local CBC/CTV/Global-like competitor politics feeds.',
			sources,
			prompt: producerMissionPrompt(sources),
			feedProbe: [],
			expectCoverageComparison: true
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
		feedProbe,
		expectCoverageComparison: false
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
- Where does coverage converge or differ across the attached outlets?
- Which outlet is leading the coverage, which outlet is following or adding reaction, and which outlet adds verification gaps?
- Why would our audience care today?
- What facts are confirmed by the feed text, and what still needs a call, document, or second source?
- What source notes should an editor see before approving the assignment?
- What should remain blocked from publishing until a human reviews it?

Write a compact, non-duplicative brief in plain newsroom language, not implementation language. Do not mention harnesses, APIs, SDKs, tests, fixtures, or databases. Do not copy navigation text, subscription prompts, or site chrome. Do not invent facts beyond the feed text. Output markdown with these sections exactly:
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
	assert(markdown.length <= 9000, `producer report is too large for acceptance (${markdown.length} chars)`);
	const wordCount = markdown.split(/\s+/).filter(Boolean).length;
	assert(wordCount <= 1400, `producer report is too wordy for acceptance (${wordCount} words)`);

	for (const section of ['Summary', 'Lead Candidates', 'Source Notes', 'Verification Notes', 'Human Review']) {
		const matches = markdown.match(new RegExp(`^##\\s+${section}\\s*$`, 'gim')) || [];
		assert(matches.length >= 1, `completed report is missing ${section}`);
		assert(matches.length === 1, `completed report repeats the ${section} section`);
	}
	assertNoRepeatedReportLoops(markdown);
	assertNoSiteChrome(markdown);

	const checks = [
		[/lead candidate|lead-worthy|lead story|top story|strongest/i, 'lead candidates'],
		[/audience|why it matters|public impact|viewers|readers|voters?|cost-of-living|public-interest|stakes/i, 'audience relevance'],
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

	if (sourceProfile.expectCoverageComparison) {
		assertCoverageComparison(markdown, sourceProfile);
	}
}

function assertProducerProgress(progress, sourceProfile) {
	assert(progress?.boardPolls > 0, 'producer acceptance did not poll the board for run progress');
	assert(progress.reportSeen === true, 'producer acceptance did not observe the saved report through the board');
	assert(progress.runStatuses.size > 0, 'board did not expose a run status for the producer mission');
	assert(
		[...progress.runStatuses].some((status) => /queued|running|completed/i.test(status)),
		`board exposed only unexpected run statuses: ${[...progress.runStatuses].join(', ')}`
	);
	const latestRun = progress.latestRun;
	assert(latestRun?.id, 'board did not expose a concrete run id for the producer mission');
	assert(
		latestRun.startedAt || latestRun.completedAt || latestRun.latestActivityAt || latestRun.updatedAt || latestRun.queuedAt,
		'board run did not expose any run timing/progress timestamp'
	);
	const bestSourceCount = Math.max(0, ...progress.sourceCounts);
	assert(
		bestSourceCount >= Math.min(1, sourceProfile.sources.length),
		`board run progress did not expose usable source activity (sourceCount=${bestSourceCount})`
	);
	assert(
		progress.stepLabels.size > 0 || progress.toolNames.size > 0,
		'board run progress did not expose steps or tool activity for producer confidence'
	);
}

function assertNoRepeatedReportLoops(markdown) {
	const headings = markdown
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^##\s+/.test(line));
	const headingSignature = headings.join(' > ').toLowerCase();
	assert(
		!/(summary > lead candidates > source notes > verification notes > human review).*\1/i.test(headingSignature),
		'producer report appears to repeat the full section loop'
	);

	const repeatedLines = new Map();
	for (const line of markdown.split(/\r?\n/)) {
		const normalized = line.replace(/\s+/g, ' ').trim().toLowerCase();
		if (normalized.length < 36 || /^##\s+/.test(normalized)) continue;
		repeatedLines.set(normalized, (repeatedLines.get(normalized) || 0) + 1);
	}
	const offenders = [...repeatedLines.entries()].filter(([, count]) => count > 2);
	assert(offenders.length === 0, `producer report repeats long lines: ${offenders[0]?.[0]}`);
}

function assertNoSiteChrome(markdown) {
	const siteChromeChecks = [
		[/skip\s+to\s+main\s+content/i, 'skip-to-main-content navigation'],
		[/\bsubscribe\b/i, 'subscription prompt'],
		[/theme\s+toggle|toggle\s+theme|dark\s+mode|light\s+mode/i, 'theme toggle chrome'],
		[/sign\s+in\s+to\s+save|create\s+an\s+account/i, 'account chrome'],
		[/advertisement|privacy\s+policy|terms\s+of\s+use/i, 'site footer/navigation chrome']
	];
	for (const [pattern, label] of siteChromeChecks) {
		assert(!pattern.test(markdown), `producer report includes ${label}`);
	}
}

function assertCoverageComparison(markdown, sourceProfile) {
	const lowerMarkdown = markdown.toLowerCase();
	for (const outlet of sourceProfile.sources) {
		const shortName = outlet.name.split(/\s+/)[0]?.toLowerCase();
		assert(shortName && lowerMarkdown.includes(shortName), `coverage comparison is missing ${outlet.name}`);
	}
	assert(
		/\b(compare|compared|comparison|converge|diverge|differ|different|while|whereas|unlike|across outlets|coverage gap|same federal|also reports)\b/i.test(
			markdown
		),
		'producer report does not include coverage-comparison language across outlets'
	);
	const paragraphs = markdown.split(/\n{2,}/);
	assert(
		paragraphs.some((paragraph) => outletMentionCount(paragraph, sourceProfile.sources) >= 2),
		'producer report does not compare at least two outlets in the same report passage'
	);
}

function outletMentionCount(text, sources) {
	const lowerText = text.toLowerCase();
	return sources.filter((source) => {
		const shortName = source.name.split(/\s+/)[0]?.toLowerCase();
		return shortName && lowerText.includes(shortName);
	}).length;
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

async function startCompetitorCoverageFixture() {
	const server = createServer((req, res) => {
		const base = `http://${req.headers.host}`;
		const pathname = new URL(req.url || '/', base).pathname;
		const outlet = COMPETITOR_FIXTURE_OUTLETS.find((candidate) => `/${candidate.slug}.rss` === pathname);
		if (outlet) {
			res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
			res.end(renderOutletFeed(base, outlet));
			return;
		}
		const page = COMPETITOR_FIXTURE_OUTLETS.flatMap((candidate) =>
			candidate.items.map((item) => ({ ...item, outlet: candidate }))
		).find((candidate) => `/${candidate.outlet.slug}/${candidate.id}` === pathname);
		if (page) {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(renderOutletPage(page.outlet, page));
			return;
		}
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('not found');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(resolve))
	};
}

function renderOutletFeed(base, outlet) {
	return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(outlet.title)}</title>
${outlet.items
	.map(
		(item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${base}/${outlet.slug}/${item.id}</link>
      <description>${escapeXml(item.description)}</description>
    </item>`
	)
	.join('\n')}
  </channel>
</rss>`;
}

function renderOutletPage(outlet, item) {
	return `<!doctype html>
<html lang="en">
	<head>
		<title>${escapeXml(item.title)}</title>
		<meta property="og:title" content="${escapeXml(item.title)}" />
	</head>
	<body>
		<main>
			<article>
				<h1>${escapeXml(item.title)}</h1>
				<p>${escapeXml(item.description)}</p>
				<p>${escapeXml(outlet.sourceName)} says an editor should compare this angle with the other attached politics outlets before assigning a package.</p>
			</article>
		</main>
	</body>
</html>`;
}

function escapeXml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
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
