import path from 'node:path';
import {
	loadNewsroomAgentConfigFromEnv,
	type NewsroomAgentConfig
} from './agents/harness-config.js';
import { providerModelIssue } from './util/openai-complete.js';

export interface HarnessConfig {
	host: string;
	port: number;
	dbPath: string;
	databaseUrl: string;
	apiKey: string;
	modelProvider: 'openai' | 'perplexity';
	modelApiKey: string;
	openAiApiKey: string;
	uiIngestUrl: string;
	uiIngestKey: string;
	runTimeoutMs: number;
	maxToolCalls: number;
	retryLimit: number;
	schedulerEnabled: boolean;
	schedulerIntervalMs: number;
	agent: NewsroomAgentConfig;
	version: string;
	production: boolean;
}

export interface HarnessConfigValidation {
	ok: boolean;
	errors: string[];
	warnings: string[];
}

function intFromEnv(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
	if (/^(0|false|no|off)$/i.test(value.trim())) return false;
	return fallback;
}

export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
	const runTimeoutMs = intFromEnv(process.env.NEWSROOM_HARNESS_RUN_TIMEOUT_MS, 90_000);
	const maxToolCalls = intFromEnv(process.env.NEWSROOM_HARNESS_MAX_TOOL_CALLS, 6);
	const modelProvider =
		overrides.modelProvider ||
		providerFromEnv(process.env.NEWSROOM_MODEL_PROVIDER) ||
		(!process.env.PERPLEXITY_API_KEY && process.env.OPENAI_API_KEY ? 'openai' : 'perplexity');
	const agent = loadNewsroomAgentConfigFromEnv({
		...(overrides.agent || {}),
		model_provider: modelProvider,
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
		modelProvider,
		modelApiKey: modelProvider === 'openai' ? process.env.OPENAI_API_KEY || '' : process.env.PERPLEXITY_API_KEY || '',
		openAiApiKey: process.env.OPENAI_API_KEY || '',
		uiIngestUrl: process.env.NEWSROOM_UI_INGEST_URL || '',
		uiIngestKey: process.env.NEWSROOM_UI_INGEST_KEY || '',
		runTimeoutMs,
		maxToolCalls,
		retryLimit: intFromEnv(process.env.NEWSROOM_HARNESS_RETRY_LIMIT, 1),
		schedulerEnabled: boolFromEnv(process.env.NEWSROOM_HARNESS_SCHEDULER_ENABLED, false),
		schedulerIntervalMs: intFromEnv(process.env.NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS, 30_000),
		agent,
		version: '0.0.1',
		production: isProductionEnv(),
		...overrides
	};
}

function providerFromEnv(value: string | undefined): HarnessConfig['modelProvider'] | undefined {
	if (value === 'openai' || value === 'perplexity') return value;
	return undefined;
}

export function validateHarnessConfig(config: HarnessConfig): HarnessConfigValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!config.apiKey) {
		const message = 'NEWSROOM_HARNESS_API_KEY is required for deployed harness private endpoints.';
		if (config.production) errors.push(message);
		else warnings.push('NEWSROOM_HARNESS_API_KEY is not configured; private endpoints will accept unauthenticated requests.');
	}
	if (!config.modelApiKey) {
		warnings.push(`${config.modelProvider === 'openai' ? 'OPENAI_API_KEY' : 'PERPLEXITY_API_KEY'} is not configured; live model calls will be unavailable.`);
	}
	const activeModelEntries = new Map<string, string>();
	for (const task of Object.values(config.agent.model_policy.tasks)) {
		if (task.tier === 'none') continue;
		activeModelEntries.set(task.tier, config.agent.model_policy.models[task.tier]);
	}
	activeModelEntries.set('web_search', config.agent.model_policy.models.web_search);
	for (const [label, model] of activeModelEntries) {
		const issue = providerModelIssue(config.modelProvider, model);
		if (issue) errors.push(`Model policy ${label}: ${issue}`);
	}
	const webSearchIssue = providerModelIssue(config.modelProvider, config.agent.web_search_model);
	if (webSearchIssue) errors.push(`NEWSROOM_WEB_SEARCH_MODEL: ${webSearchIssue}`);

	return {
		ok: errors.length === 0,
		errors,
		warnings
	};
}

function isProductionEnv(): boolean {
	return process.env.NODE_ENV === 'production' || process.env.VERCEL === '1' || process.env.NEWSROOM_HARNESS_DEPLOYED === '1';
}
