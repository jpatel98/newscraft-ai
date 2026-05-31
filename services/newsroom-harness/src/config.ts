import path from 'node:path';
import {
	loadNewsroomAgentConfigFromEnv,
	type NewsroomAgentConfig
} from './agents/harness-config.js';

export interface HarnessConfig {
	host: string;
	port: number;
	dbPath: string;
	databaseUrl: string;
	apiKey: string;
	openAiApiKey: string;
	uiIngestUrl: string;
	uiIngestKey: string;
	runTimeoutMs: number;
	maxToolCalls: number;
	retryLimit: number;
	schedulerIntervalMs: number;
	agent: NewsroomAgentConfig;
	version: string;
}

function intFromEnv(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	const runTimeoutMs = intFromEnv(process.env.NEWSROOM_HARNESS_RUN_TIMEOUT_MS, 90_000);
	const maxToolCalls = intFromEnv(process.env.NEWSROOM_HARNESS_MAX_TOOL_CALLS, 6);
	const agent = loadNewsroomAgentConfigFromEnv({
		default_tool_budget: {
			max_total_tool_calls: maxToolCalls,
			max_custom_tool_calls: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_CUSTOM_TOOL_CALLS, 4),
			max_web_searches: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_WEB_SEARCHES, 3),
			max_browser_tasks: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_BROWSER_TASKS, 2),
			max_runtime_seconds: Math.ceil(runTimeoutMs / 1000)
		}
	});
	return {
		host: process.env.NEWSROOM_HARNESS_HOST || '127.0.0.1',
		port: intFromEnv(process.env.NEWSROOM_HARNESS_PORT, 8650),
		dbPath: process.env.NEWSROOM_HARNESS_DB_PATH || path.join(process.cwd(), '.data', 'newsroom-harness.db'),
		databaseUrl: process.env.NEWSROOM_HARNESS_DATABASE_URL || '',
		apiKey: process.env.NEWSROOM_HARNESS_API_KEY || '',
		openAiApiKey: process.env.OPENAI_API_KEY || '',
		uiIngestUrl: process.env.NEWSROOM_UI_INGEST_URL || '',
		uiIngestKey: process.env.NEWSROOM_UI_INGEST_KEY || '',
		runTimeoutMs,
		maxToolCalls,
		retryLimit: intFromEnv(process.env.NEWSROOM_HARNESS_RETRY_LIMIT, 1),
		schedulerIntervalMs: intFromEnv(process.env.NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS, 30_000),
		agent,
		version: '0.0.1',
		...overrides
	};
}
