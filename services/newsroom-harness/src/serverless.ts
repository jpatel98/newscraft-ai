import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
	GatewayChatCompletionRequest,
	GatewayHealthResponse,
	GatewayResponsesRequest
} from '@newscraft/shared';
import { writeChatCompletion, writeResponses } from './chat.js';
import { loadConfig, validateHarnessConfig } from './config.js';
import { NewsroomAgentRuntime } from './agents/runtime.js';
import { bearerToken, requestTraceId, HttpError, readJson, tokenMatches, writeJson, writeText } from './util/http.js';

export function createVercelHarnessHandler() {
	const config = loadConfig({
		schedulerEnabled: false
	});
	const runtime = new NewsroomAgentRuntime({
		maxToolCalls: config.maxToolCalls,
		runTimeoutMs: config.runTimeoutMs,
		retryLimit: config.retryLimit,
		modelProvider: config.modelProvider,
		modelApiKey: config.modelApiKey,
		openAiApiKey: config.openAiApiKey,
		agentConfig: config.agent
	});

	return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url || '/', `https://${req.headers.host || 'newscraft-harness.vercel.app'}`);
			if (req.method === 'GET' && url.pathname === '/health') {
				const body = serverlessHealth(config);
				writeJson(res, body.ok ? 200 : 503, body);
				return;
			}

			const configStatus = validateHarnessConfig(config);
			if (!configStatus.ok) {
				throw new HttpError(503, 'harness is not configured for private requests');
			}
			if (config.apiKey && !tokenMatches(bearerToken(req), config.apiKey)) {
				throw new HttpError(401, 'unauthorized');
			}

			if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
				const body = await readJson<GatewayChatCompletionRequest>(req);
				const traceId = requestTraceId(req.headers, body.trace_id);
				await writeChatCompletion(res, body, runtime, requestAbortSignal(req, res).signal, traceId);
				return;
			}

			if (req.method === 'POST' && url.pathname === '/v1/responses') {
				const body = await readJson<GatewayResponsesRequest>(req);
				const traceId = requestTraceId(req.headers, body.trace_id);
				await writeResponses(res, body, runtime, requestAbortSignal(req, res).signal, traceId);
				return;
			}

			writeText(res, 404, 'not found');
		} catch (err) {
			handleError(res, err);
		}
	};
}

function serverlessHealth(config: ReturnType<typeof loadConfig>): GatewayHealthResponse {
	const configStatus = validateHarnessConfig(config);
	return {
		ok: configStatus.ok,
		service: 'newsroom-harness',
		version: config.version,
		time: new Date().toISOString(),
		uptimeSeconds: Math.round(process.uptime()),
		db: {
			ok: true,
			path: '',
			backend: 'stateless'
		},
		openai: { configured: Boolean(config.openAiApiKey) },
		modelProvider: { name: config.modelProvider, configured: Boolean(config.modelApiKey) },
		config: configStatus,
		scheduler: {
			enabled: false,
			running: false,
			intervalMs: config.schedulerIntervalMs,
			dueJobs: null,
			activeRuns: null
		},
		capabilities: {
			chat: true,
			responses: true,
			jobs: false,
			runs: false,
			reports: false,
			memory: false,
			savedResearch: false,
			documents: true,
			scheduler: false,
			persistence: 'stateless'
		},
		ingest: {
			configured: Boolean(config.uiIngestUrl && config.uiIngestKey),
			urlConfigured: Boolean(config.uiIngestUrl),
			keyConfigured: Boolean(config.uiIngestKey)
		},
		limits: {
			runTimeoutMs: config.runTimeoutMs,
			maxToolCalls: config.maxToolCalls,
			retryLimit: config.retryLimit
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
	console.error('NewsCraft serverless harness request failed', err instanceof Error ? err.message : String(err));
	writeText(res, 500, 'internal server error');
}
