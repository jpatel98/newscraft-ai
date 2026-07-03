import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, validateHarnessConfig } from '../src/config.js';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_HARNESS_DATABASE_URL = process.env.NEWSROOM_HARNESS_DATABASE_URL;
const ORIGINAL_SCHEDULER_ENABLED = process.env.NEWSROOM_HARNESS_SCHEDULER_ENABLED;
const ORIGINAL_MODEL_POLICY_MODE = process.env.NEWSROOM_MODEL_POLICY_MODE;
const ORIGINAL_ALLOW_SCHEDULED_MODEL_CALLS = process.env.NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS;
const ORIGINAL_MODEL_PROVIDER = process.env.NEWSROOM_MODEL_PROVIDER;
const ORIGINAL_WEB_SEARCH_MODEL = process.env.NEWSROOM_WEB_SEARCH_MODEL;
const ORIGINAL_MODEL_NANO = process.env.NEWSROOM_MODEL_NANO;
const ORIGINAL_MODEL_MINI = process.env.NEWSROOM_MODEL_MINI;
const ORIGINAL_MODEL_STANDARD = process.env.NEWSROOM_MODEL_STANDARD;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VERCEL = process.env.VERCEL;
const ORIGINAL_DEPLOYED = process.env.NEWSROOM_HARNESS_DEPLOYED;
const ORIGINAL_API_KEY = process.env.NEWSROOM_HARNESS_API_KEY;

afterEach(() => {
	restoreEnv('DATABASE_URL', ORIGINAL_DATABASE_URL);
	restoreEnv('NEWSROOM_HARNESS_DATABASE_URL', ORIGINAL_HARNESS_DATABASE_URL);
	restoreEnv('NEWSROOM_HARNESS_SCHEDULER_ENABLED', ORIGINAL_SCHEDULER_ENABLED);
	restoreEnv('NEWSROOM_MODEL_POLICY_MODE', ORIGINAL_MODEL_POLICY_MODE);
	restoreEnv('NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS', ORIGINAL_ALLOW_SCHEDULED_MODEL_CALLS);
	restoreEnv('NEWSROOM_MODEL_PROVIDER', ORIGINAL_MODEL_PROVIDER);
	restoreEnv('NEWSROOM_WEB_SEARCH_MODEL', ORIGINAL_WEB_SEARCH_MODEL);
	restoreEnv('NEWSROOM_MODEL_NANO', ORIGINAL_MODEL_NANO);
	restoreEnv('NEWSROOM_MODEL_MINI', ORIGINAL_MODEL_MINI);
	restoreEnv('NEWSROOM_MODEL_STANDARD', ORIGINAL_MODEL_STANDARD);
	restoreEnv('NODE_ENV', ORIGINAL_NODE_ENV);
	restoreEnv('VERCEL', ORIGINAL_VERCEL);
	restoreEnv('NEWSROOM_HARNESS_DEPLOYED', ORIGINAL_DEPLOYED);
	restoreEnv('NEWSROOM_HARNESS_API_KEY', ORIGINAL_API_KEY);
});

describe('harness config', () => {
	it('does not use the UI DATABASE_URL as the harness mirror database', () => {
		process.env.DATABASE_URL = 'postgres://ui-db.example/postgres';
		delete process.env.NEWSROOM_HARNESS_DATABASE_URL;

		expect(loadConfig().databaseUrl).toBe('');
	});

	it('enables Supabase mirroring only with NEWSROOM_HARNESS_DATABASE_URL', () => {
		process.env.DATABASE_URL = 'postgres://ui-db.example/postgres';
		process.env.NEWSROOM_HARNESS_DATABASE_URL = 'postgres://harness-db.example/postgres';

		expect(loadConfig().databaseUrl).toBe('postgres://harness-db.example/postgres');
	});

	it('keeps the scheduler off unless explicitly enabled', () => {
		delete process.env.NEWSROOM_HARNESS_SCHEDULER_ENABLED;
		expect(loadConfig().schedulerEnabled).toBe(false);

		process.env.NEWSROOM_HARNESS_SCHEDULER_ENABLED = 'true';
		expect(loadConfig().schedulerEnabled).toBe(true);
	});

	it('defaults scheduled model calls off even in balanced policy mode', () => {
		process.env.NEWSROOM_MODEL_POLICY_MODE = 'balanced';
		delete process.env.NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS;

		expect(loadConfig().agent.model_policy.scheduled.allow_model_calls).toBe(false);
		expect(loadConfig().agent.model_policy.tasks.scheduled_research_update.tier).toBe('mini');
	});

	it('allows scheduled model calls only through an explicit policy flag', () => {
		process.env.NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS = '1';

		expect(loadConfig().agent.model_policy.scheduled.allow_model_calls).toBe(true);
	});

	it('uses OpenAI-compatible defaults when the selected provider is OpenAI', () => {
		process.env.NEWSROOM_MODEL_PROVIDER = 'openai';
		delete process.env.NEWSROOM_WEB_SEARCH_MODEL;
		delete process.env.NEWSROOM_MODEL_NANO;
		delete process.env.NEWSROOM_MODEL_MINI;
		delete process.env.NEWSROOM_MODEL_STANDARD;

		const config = loadConfig();

		expect(config.agent.model_policy.models.nano).toBe('openai/gpt-5-mini');
		expect(config.agent.model_policy.models.mini).toBe('openai/gpt-5-mini');
		expect(config.agent.model_policy.models.standard).toBe('openai/gpt-5-mini');
		expect(config.agent.web_search_model).toBe('openai/gpt-5-mini');
		expect(validateHarnessConfig(config).errors).toEqual([]);
	});

	it('reports active provider/model mismatches in config validation', () => {
		process.env.NEWSROOM_MODEL_PROVIDER = 'openai';
		process.env.NEWSROOM_WEB_SEARCH_MODEL = 'perplexity/sonar';

		expect(validateHarnessConfig(loadConfig()).errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('NEWSROOM_MODEL_PROVIDER=openai cannot use Perplexity model "perplexity/sonar"')
			])
		);
	});

	it('reports obvious plain model family mismatches in config validation', () => {
		process.env.NEWSROOM_MODEL_PROVIDER = 'perplexity';
		process.env.NEWSROOM_WEB_SEARCH_MODEL = 'gpt-5-mini';

		expect(validateHarnessConfig(loadConfig()).errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining('NEWSROOM_MODEL_PROVIDER=perplexity cannot use apparent OpenAI model "gpt-5-mini"')
			])
		);
	});

	it('hard-fails missing harness auth when deployed', () => {
		process.env.NEWSROOM_HARNESS_DEPLOYED = '1';
		delete process.env.NEWSROOM_HARNESS_API_KEY;

		const validation = validateHarnessConfig(loadConfig());

		expect(validation.errors).toEqual(
			expect.arrayContaining([
				'NEWSROOM_HARNESS_API_KEY is required for deployed harness private endpoints.'
			])
		);
	});
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
