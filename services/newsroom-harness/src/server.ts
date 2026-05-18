import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CreateJobInput, GatewayChatCompletionRequest, GatewayResponsesRequest, UpdateJobInput } from '@newscraft/shared';
import { writeChatCompletion, writeResponses } from './chat.js';
import { loadConfig, type HarnessConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { HarnessRepository } from './db/repository.js';
import { NewsroomAgentRuntime } from './agents/runtime.js';
import { JobRunner } from './jobs/runner.js';
import { JobScheduler } from './jobs/scheduler.js';
import { bearerToken, HttpError, readJson, tokenMatches, writeJson, writeText } from './util/http.js';

export interface HarnessServer {
	server: Server;
	config: HarnessConfig;
	repository: HarnessRepository;
	runner: JobRunner;
	scheduler: JobScheduler;
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
	const repository = options.repository || new HarnessRepository(openDatabase(config.dbPath));
	const runtime =
		options.runtime ||
		new NewsroomAgentRuntime({
			maxToolCalls: config.maxToolCalls,
			runTimeoutMs: config.runTimeoutMs,
			retryLimit: config.retryLimit,
			openAiApiKey: config.openAiApiKey
		});
	const runner = new JobRunner(repository, runtime, config);
	const scheduler = new JobScheduler(repository, runner, config);
	const server = createServer((req, res) => {
		void route(req, res, { config, repository, runtime, runner }).catch((err) => handleError(res, err));
	});
	server.on('close', () => scheduler.stop());
	if (options.startScheduler !== false) scheduler.start();
	return {
		server,
		config,
		repository,
		runner,
		scheduler,
		url() {
			const address = server.address() as AddressInfo | null;
			const port = address?.port ?? config.port;
			return `http://${config.host}:${port}`;
		},
		close() {
			scheduler.stop();
			return new Promise((resolve, reject) => {
				server.close((err) => {
					repository.close();
					if (err) reject(err);
					else resolve();
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
	}
): Promise<void> {
	const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
	if (req.method === 'GET' && url.pathname === '/health') {
		writeJson(res, 200, {
			ok: true,
			service: 'newsroom-harness',
			version: ctx.config.version,
			time: new Date().toISOString(),
			db: { ok: ctx.repository.healthcheck(), path: ctx.config.dbPath },
			openai: { configured: Boolean(ctx.config.openAiApiKey) }
		});
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
		writeJson(res, 200, {
			runs: ctx.repository.listRuns({
				includeCompleted: url.searchParams.get('include_completed') === 'true',
				includeRecent: url.searchParams.get('include_recent') === 'true'
			})
		});
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
			const run = ctx.runner.start(id, 'manual');
			writeJson(res, 202, { ok: true, run, job: ctx.repository.requireJob(id) });
			return;
		}
	}

	throw new HttpError(404, 'not found');
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
