import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
	CreateJobInput,
	ExecuteCrawlPlanInput,
	GatewayChatCompletionRequest,
	GatewayHealthResponse,
	GatewayResponsesRequest,
	NewsroomGateStatus,
	QueueGateInput,
	ResolveGateInput,
	SaveCrawlPlanVersionInput,
	UpdateJobInput
} from '@newscraft/shared';
import { writeChatCompletion, writeResponses } from './chat.js';
import { loadConfig, type HarnessConfig } from './config.js';
import { createHarnessRepository } from './db/factory.js';
import { HarnessRepository } from './db/repository.js';
import { deliverPackage, DeliveryPreconditionError } from './agents/delivery.js';
import { DraftingPreconditionError, runDraftingAgent } from './agents/drafting.js';
import { runEditorCommand } from './agents/editor-command.js';
import { PackagerPreconditionError, listStoryPackages, runPackagerAgent } from './agents/packager.js';
import { NewsroomAgentRuntime } from './agents/runtime.js';
import { executeCrawlPlan } from './crawl-plans/executor.js';
import { JobRunner } from './jobs/runner.js';
import { JobScheduler } from './jobs/scheduler.js';
import { bearerToken, HttpError, readJson, tokenMatches, writeJson, writeText } from './util/http.js';

export interface HarnessServer {
	server: Server;
	config: HarnessConfig;
	repository: HarnessRepository;
	runner: JobRunner;
	scheduler: JobScheduler;
	ready: Promise<void>;
	url(): string;
	close(): Promise<void>;
}

export function createHarnessServer(options: {
	config?: Partial<HarnessConfig>;
	startScheduler?: boolean;
	repository?: HarnessRepository;
	runtime?: NewsroomAgentRuntime;
} = {}): HarnessServer {
	const config = loadConfig(options.config);
	const repositoryBundle = options.repository
		? { repository: options.repository, ready: Promise.resolve() }
		: createHarnessRepository(config);
	const { repository, ready } = repositoryBundle;
	const runtime =
		options.runtime ||
		new NewsroomAgentRuntime({
			maxToolCalls: config.maxToolCalls,
			runTimeoutMs: config.runTimeoutMs,
			retryLimit: config.retryLimit,
			openAiApiKey: config.openAiApiKey,
			agentConfig: config.agent
		});
	const runner = new JobRunner(repository, runtime, config);
	const scheduler = new JobScheduler(repository, runner, config);
	const server = createServer((req, res) => {
		void route(req, res, { config, repository, runtime, runner, scheduler }).catch((err) => handleError(res, err));
	});
	server.on('close', () => scheduler.stop());
	if (options.startScheduler !== false) scheduler.start();
	return {
		server,
		config,
		repository,
		runner,
		scheduler,
		ready,
		url() {
			const address = server.address() as AddressInfo | null;
			const port = address?.port ?? config.port;
			return `http://${config.host}:${port}`;
		},
		close() {
			scheduler.stop();
			return new Promise((resolve, reject) => {
				server.close((err) => {
					void Promise.resolve(repository.close()).then(
						() => {
							if (err) reject(err);
							else resolve();
						},
						(closeErr) => reject(closeErr)
					);
				});
			});
		}
	};
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: {
		config: HarnessConfig;
		repository: HarnessRepository;
		runtime: NewsroomAgentRuntime;
		runner: JobRunner;
		scheduler: JobScheduler;
	}
): Promise<void> {
	const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
	if (req.method === 'GET' && url.pathname === '/health') {
		const body = harnessHealth(ctx);
		writeJson(res, body.ok ? 200 : 503, body);
		return;
	}

	if (ctx.config.apiKey && !tokenMatches(bearerToken(req), ctx.config.apiKey)) {
		throw new HttpError(401, 'unauthorized');
	}

	if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
		const body = await readJson<GatewayChatCompletionRequest>(req);
		const abort = requestAbortSignal(req, res);
		await writeChatCompletion(res, body, ctx.runtime, abort.signal);
		return;
	}

	if (req.method === 'POST' && url.pathname === '/v1/responses') {
		const body = await readJson<GatewayResponsesRequest>(req);
		const abort = requestAbortSignal(req, res);
		await writeResponses(res, body, ctx.runtime, abort.signal);
		return;
	}

	if (req.method === 'GET' && url.pathname === '/api/jobs') {
		const includeDisabled = url.searchParams.get('include_disabled') === 'true';
		writeJson(res, 200, { jobs: ctx.repository.listJobs(includeDisabled) });
		return;
	}

	if (req.method === 'POST' && url.pathname === '/api/jobs') {
		const input = await readJson<CreateJobInput>(req);
		writeJson(res, 201, { ok: true, job: ctx.repository.createJob(input) });
		return;
	}

	if (req.method === 'GET' && url.pathname === '/api/runs') {
		ctx.runner.clearStaleActiveRuns();
		writeJson(res, 200, {
			runs: ctx.repository.listRuns({
				includeCompleted: url.searchParams.get('include_completed') === 'true',
				includeRecent: url.searchParams.get('include_recent') === 'true',
				jobIds: queryList(url, 'job_id', 'job_ids')
			})
		});
		return;
	}

	if (req.method === 'GET' && url.pathname === '/api/reports') {
		const jobIds = new Set(queryList(url, 'job_id', 'job_ids'));
		const reports = ctx.repository.listReports().filter((report) => jobIds.size === 0 || jobIds.has(report.job_id));
		writeJson(res, 200, { reports });
		return;
	}

	if (req.method === 'GET' && url.pathname === '/api/events') {
		writeJson(res, 200, {
			events: ctx.repository.listEvents({
				workspaceId: queryText(url, 'workspace_id'),
				storyId: queryText(url, 'story_id'),
				jobId: queryText(url, 'job_id'),
				runId: queryText(url, 'run_id'),
				afterId: queryText(url, 'after_id'),
				limit: queryLimit(url)
			})
		});
		return;
	}

	if (req.method === 'GET' && url.pathname === '/api/gates') {
		writeJson(res, 200, {
			gates: ctx.repository.listGates({
				workspaceId: queryText(url, 'workspace_id'),
				storyId: queryText(url, 'story_id'),
				jobId: queryText(url, 'job_id'),
				runId: queryText(url, 'run_id'),
				status: queryGateStatus(url),
				limit: queryLimit(url)
			})
		});
		return;
	}

	if (req.method === 'POST' && url.pathname === '/api/gates') {
		const input = await readJson<QueueGateInput>(req);
		writeJson(res, 201, { ok: true, gate: ctx.repository.queueGate(input) });
		return;
	}

	const gateAction = url.pathname.match(/^\/api\/gates\/([^/]+)(?:\/resolve)?$/);
	if (gateAction) {
		const id = decodeURIComponent(gateAction[1]);
		const isResolve = url.pathname.endsWith('/resolve');
		if (req.method === 'GET' && !isResolve) {
			writeJson(res, 200, { gate: ctx.repository.requireGate(id) });
			return;
		}
		if (req.method === 'POST' && isResolve) {
			const input = await readJson<ResolveGateInput>(req);
			writeJson(res, 200, { ok: true, ...ctx.repository.resolveGate(id, input) });
			return;
		}
	}

	if (req.method === 'GET' && url.pathname === '/api/crawl-plans') {
		const beatId = requiredQueryText(url, 'beat_id');
		writeJson(res, 200, {
			crawl_plans: ctx.repository.listCrawlPlanVersions(beatId, queryText(url, 'plan_id'))
		});
		return;
	}

	if (req.method === 'POST' && url.pathname === '/api/crawl-plans') {
		const input = await readJson<SaveCrawlPlanVersionInput>(req);
		writeJson(res, 201, { ok: true, crawl_plan: ctx.repository.saveCrawlPlanVersion(input) });
		return;
	}

	if (req.method === 'POST' && url.pathname === '/api/editor-commands') {
		const input = await readJson<{
			command?: string;
			workspace_id?: string;
			story_id?: string | null;
			job_id?: string | null;
			run_id?: string | null;
			target_agent?: 'monitor' | 'research' | 'verification' | 'copy' | 'drafting' | 'packaging' | null;
			target_word_count?: number;
			facts?: unknown[];
		}>(req);
		if (!input.command?.trim()) throw new HttpError(400, 'command is required');
		const abort = requestAbortSignal(req, res);
		writeJson(res, 200, {
			ok: true,
			result: await runEditorCommand(
				ctx.repository,
				{
					command: input.command || '',
					workspaceId: input.workspace_id,
					storyId: input.story_id,
					jobId: input.job_id,
					runId: input.run_id,
					targetAgent: input.target_agent,
					targetWordCount: input.target_word_count,
					facts: input.facts
				},
				{ signal: abort.signal }
			)
		});
		return;
	}

	const crawlPlanAction = url.pathname.match(/^\/api\/crawl-plans\/([^/]+)(?:\/execute)?$/);
	if (crawlPlanAction) {
		const id = decodeURIComponent(crawlPlanAction[1]);
		const beatId = requiredQueryText(url, 'beat_id');
		const isExecute = url.pathname.endsWith('/execute');
		if (req.method === 'GET' && !isExecute) {
			const version = queryNumber(url, 'version');
			writeJson(res, 200, { crawl_plan: ctx.repository.requireCrawlPlanVersion(beatId, id, version) });
			return;
		}
		if (req.method === 'POST' && isExecute) {
			const input = await readJson<ExecuteCrawlPlanInput>(req);
			writeJson(res, 200, { ok: true, ...(await executeCrawlPlan(ctx.repository, beatId, id, input)) });
			return;
		}
	}

	if (req.method === 'GET' && (url.pathname === '/api/memory/house' || url.pathname === '/api/memory/house/inspect')) {
		writeJson(res, 200, { memory: ctx.repository.inspectHouseMemory() });
		return;
	}

	if (req.method === 'PATCH' && url.pathname === '/api/memory/house') {
		const input = await readJson<{ values?: Record<string, unknown>; actor?: string } & Record<string, unknown>>(req);
		const { values, actor, ...directValues } = input;
		writeJson(res, 200, {
			ok: true,
			memory: ctx.repository.updateHouseMemory(values || directValues, actor || 'editor')
		});
		return;
	}

	const beatMemory = url.pathname.match(/^\/api\/memory\/beats\/([^/]+)(?:\/inspect)?$/);
	if (beatMemory) {
		const beatId = decodeURIComponent(beatMemory[1]);
		if (req.method === 'GET') {
			writeJson(res, 200, { memory: ctx.repository.inspectBeatMemory(beatId) });
			return;
		}
		if (req.method === 'POST') {
			const input = await readJson<{ key: string; value: unknown; kind?: string; actor?: string }>(req);
			writeJson(res, 201, {
				ok: true,
				entry: ctx.repository.appendBeatMemory(beatId, input),
				memory: ctx.repository.inspectBeatMemory(beatId)
			});
			return;
		}
	}

	const storyMemory = url.pathname.match(/^\/api\/memory\/stories\/([^/]+)(?:\/inspect)?$/);
	if (storyMemory) {
		const storyId = decodeURIComponent(storyMemory[1]);
		const workspaceId = queryText(url, 'workspace_id');
		if (req.method === 'GET') {
			writeJson(res, 200, { memory: ctx.repository.inspectStoryMemory(storyId, workspaceId) });
			return;
		}
		if (req.method === 'POST') {
			const input = await readJson<{ key: string; value: unknown; kind?: string; actor?: string }>(req);
			writeJson(res, 201, {
				ok: true,
				entry: ctx.repository.appendStoryMemory(storyId, { ...input, workspaceId: workspaceId ?? undefined }),
				memory: ctx.repository.inspectStoryMemory(storyId, workspaceId)
			});
			return;
		}
	}

	const storyDraft = url.pathname.match(/^\/api\/stories\/([^/]+)\/drafts\/web-story$/);
	if (storyDraft) {
		const storyId = decodeURIComponent(storyDraft[1]);
		if (req.method === 'POST') {
			const input = await readJson<{
				workspace_id?: string;
				job_id?: string | null;
				run_id?: string | null;
				target_word_count?: number;
			}>(req);
			if (!input.workspace_id?.trim()) throw new HttpError(400, 'workspace_id is required');
			try {
				writeJson(res, 201, {
					ok: true,
					...runDraftingAgent(ctx.repository, {
						storyId,
						workspaceId: input.workspace_id,
						jobId: input.job_id,
						runId: input.run_id,
						targetWordCount: input.target_word_count
					})
				});
			} catch (err) {
				if (err instanceof DraftingPreconditionError) throw new HttpError(409, err.message);
				throw err;
			}
			return;
		}
	}

	const storyPackages = url.pathname.match(/^\/api\/stories\/([^/]+)\/packages$/);
	if (storyPackages) {
		const storyId = decodeURIComponent(storyPackages[1]);
		if (req.method === 'GET') {
			const workspaceId = requiredQueryText(url, 'workspace_id');
			writeJson(res, 200, { packages: listStoryPackages(ctx.repository, storyId, workspaceId) });
			return;
		}
		if (req.method === 'POST') {
			const input = await readJson<{
				workspace_id?: string;
				job_id?: string | null;
				run_id?: string | null;
				draft_event_id?: string | null;
			}>(req);
			if (!input.workspace_id?.trim()) throw new HttpError(400, 'workspace_id is required');
			try {
				writeJson(res, 201, {
					ok: true,
					...runPackagerAgent(ctx.repository, {
						storyId,
						workspaceId: input.workspace_id,
						jobId: input.job_id,
						runId: input.run_id,
						draftEventId: input.draft_event_id
					})
				});
			} catch (err) {
				if (err instanceof PackagerPreconditionError) throw new HttpError(409, err.message);
				throw err;
			}
			return;
		}
	}

	const packageDelivery = url.pathname.match(/^\/api\/stories\/([^/]+)\/packages\/([^/]+)\/deliver$/);
	if (packageDelivery && req.method === 'POST') {
		const storyId = decodeURIComponent(packageDelivery[1]);
		const packageId = decodeURIComponent(packageDelivery[2]);
		const input = await readJson<{
			workspace_id?: string;
			job_id?: string | null;
			run_id?: string | null;
			channel?: 'email_digest' | 'webhook' | 'slack' | 'wordpress';
			target_url?: string | null;
			wordpress_post_id?: string | number | null;
			actor?: string;
		}>(req);
		if (!input.workspace_id?.trim()) throw new HttpError(400, 'workspace_id is required');
		if (!input.channel?.trim()) throw new HttpError(400, 'channel is required');
		try {
			const result = await deliverPackage(ctx.repository, ctx.config, {
				storyId,
				packageId,
				workspaceId: input.workspace_id,
				jobId: input.job_id,
				runId: input.run_id,
				channel: input.channel,
				targetUrl: input.target_url,
				wordpressPostId: input.wordpress_post_id,
				actor: input.actor
			});
			writeJson(res, result.ok ? 200 : 409, { ok: result.ok, delivery: result });
		} catch (err) {
			if (err instanceof DeliveryPreconditionError || err instanceof PackagerPreconditionError) {
				throw new HttpError(409, err.message);
			}
			throw err;
		}
		return;
	}

	const jobAction = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(run|pause|resume))?$/);
	if (jobAction) {
		const id = decodeURIComponent(jobAction[1]);
		const action = jobAction[2] as 'run' | 'pause' | 'resume' | undefined;
		if (req.method === 'PATCH' && !action) {
			const input = await readJson<UpdateJobInput>(req);
			writeJson(res, 200, { ok: true, job: ctx.repository.updateJob(id, input) });
			return;
		}
		if (req.method === 'DELETE' && !action) {
			if (!ctx.repository.deleteJob(id)) throw new HttpError(404, 'Mission not found');
			writeJson(res, 200, { ok: true });
			return;
		}
		if (req.method === 'POST' && action === 'pause') {
			writeJson(res, 200, { ok: true, job: ctx.repository.setJobEnabled(id, false) });
			return;
		}
		if (req.method === 'POST' && action === 'resume') {
			writeJson(res, 200, { ok: true, job: ctx.repository.setJobEnabled(id, true) });
			return;
		}
		if (req.method === 'POST' && action === 'run') {
			const input = (await readJson<{ workspace_id?: string }>(req).catch(() => null)) ?? {};
			const workspaceId = typeof input.workspace_id === 'string' ? input.workspace_id : undefined;
			const run = ctx.runner.start(id, 'manual', workspaceId);
			writeJson(res, 202, { ok: true, run, job: ctx.repository.requireJob(id) });
			return;
		}
	}

	throw new HttpError(404, 'not found');
}

function publicError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function queryText(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key)?.trim();
	return value || undefined;
}

function queryList(url: URL, singleKey: string, listKey: string): string[] {
	return [
		...url.searchParams.getAll(singleKey),
		...url.searchParams.getAll(listKey).flatMap((value) => value.split(','))
	]
		.map((value) => value.trim())
		.filter(Boolean);
}

function requiredQueryText(url: URL, key: string): string {
	const value = queryText(url, key);
	if (!value) throw new HttpError(400, `${key} is required`);
	return value;
}

function queryLimit(url: URL): number | undefined {
	const value = Number.parseInt(url.searchParams.get('limit') || '', 10);
	return Number.isFinite(value) ? value : undefined;
}

function queryNumber(url: URL, key: string): number | undefined {
	const value = Number.parseInt(url.searchParams.get(key) || '', 10);
	return Number.isFinite(value) ? value : undefined;
}

function queryGateStatus(url: URL): NewsroomGateStatus | 'all' | undefined {
	const value = queryText(url, 'status');
	if (value === undefined || value === 'open' || value === 'resolved' || value === 'all') return value;
	throw new HttpError(400, `Unsupported gate status: ${value}`);
}

function harnessHealth(ctx: {
	config: HarnessConfig;
	repository: HarnessRepository;
	scheduler: JobScheduler;
}): GatewayHealthResponse {
	let dbOk = false;
	let dbError: string | undefined;
	let dueJobs: number | null = null;
	let activeRuns: number | null = null;
	try {
		dbOk = ctx.repository.healthcheck();
		dueJobs = ctx.repository.dueJobs().length;
		activeRuns = ctx.repository.listRuns({ includeCompleted: false }).length;
	} catch (err) {
		dbError = publicError(err);
	}

	return {
		ok: dbOk,
		service: 'newsroom-harness',
		version: ctx.config.version,
		time: new Date().toISOString(),
		uptimeSeconds: Math.round(process.uptime()),
		db: {
			ok: dbOk,
			path: ctx.config.dbPath,
			backend: ctx.config.databaseUrl ? 'sqlite+supabase' : 'sqlite',
			error: dbError
		},
		openai: { configured: Boolean(ctx.config.openAiApiKey) },
		scheduler: {
			running: ctx.scheduler.isRunning(),
			intervalMs: ctx.config.schedulerIntervalMs,
			dueJobs,
			activeRuns
		},
		ingest: {
			configured: Boolean(ctx.config.uiIngestUrl && ctx.config.uiIngestKey),
			urlConfigured: Boolean(ctx.config.uiIngestUrl),
			keyConfigured: Boolean(ctx.config.uiIngestKey)
		},
		limits: {
			runTimeoutMs: ctx.config.runTimeoutMs,
			maxToolCalls: ctx.config.maxToolCalls,
			retryLimit: ctx.config.retryLimit
		}
	};
}

function requestAbortSignal(req: IncomingMessage, res?: ServerResponse): AbortController {
	const abort = new AbortController();
	req.on('aborted', () => abort.abort());
	res?.on('close', () => {
		if (!res.writableEnded) abort.abort();
	});
	return abort;
}

function handleError(res: ServerResponse, err: unknown): void {
	if (res.headersSent) {
		res.destroy(err instanceof Error ? err : new Error(String(err)));
		return;
	}
	if (err instanceof HttpError) {
		writeText(res, err.status, err.message);
		return;
	}
	writeText(res, 500, err instanceof Error ? err.message : String(err));
}
