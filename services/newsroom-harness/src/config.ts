import path from 'node:path';

export interface HarnessConfig {
	host: string;
	port: number;
	dbPath: string;
	apiKey: string;
	openAiApiKey: string;
	uiIngestUrl: string;
	uiIngestKey: string;
	runTimeoutMs: number;
	maxToolCalls: number;
	retryLimit: number;
	schedulerIntervalMs: number;
	version: string;
}

function intFromEnv(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	return {
		host: process.env.NEWSROOM_HARNESS_HOST || '127.0.0.1',
		port: intFromEnv(process.env.NEWSROOM_HARNESS_PORT, 8650),
		dbPath: process.env.NEWSROOM_HARNESS_DB_PATH || path.join(process.cwd(), '.data', 'newsroom-harness.db'),
		apiKey: process.env.NEWSROOM_HARNESS_API_KEY || '',
		openAiApiKey: process.env.OPENAI_API_KEY || '',
		uiIngestUrl: process.env.NEWSROOM_UI_INGEST_URL || '',
		uiIngestKey: process.env.NEWSROOM_UI_INGEST_KEY || '',
		runTimeoutMs: intFromEnv(process.env.NEWSROOM_HARNESS_RUN_TIMEOUT_MS, 90_000),
		maxToolCalls: intFromEnv(process.env.NEWSROOM_HARNESS_MAX_TOOL_CALLS, 8),
		retryLimit: intFromEnv(process.env.NEWSROOM_HARNESS_RETRY_LIMIT, 1),
		schedulerIntervalMs: intFromEnv(process.env.NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS, 30_000),
		version: '0.0.1',
		...overrides
	};
}
