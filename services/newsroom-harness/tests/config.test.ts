import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_HARNESS_DATABASE_URL = process.env.NEWSROOM_HARNESS_DATABASE_URL;
const ORIGINAL_SCHEDULER_ENABLED = process.env.NEWSROOM_HARNESS_SCHEDULER_ENABLED;
const ORIGINAL_MODEL_POLICY_MODE = process.env.NEWSROOM_MODEL_POLICY_MODE;
const ORIGINAL_ALLOW_SCHEDULED_MODEL_CALLS = process.env.NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS;

afterEach(() => {
	restoreEnv('DATABASE_URL', ORIGINAL_DATABASE_URL);
	restoreEnv('NEWSROOM_HARNESS_DATABASE_URL', ORIGINAL_HARNESS_DATABASE_URL);
	restoreEnv('NEWSROOM_HARNESS_SCHEDULER_ENABLED', ORIGINAL_SCHEDULER_ENABLED);
	restoreEnv('NEWSROOM_MODEL_POLICY_MODE', ORIGINAL_MODEL_POLICY_MODE);
	restoreEnv('NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS', ORIGINAL_ALLOW_SCHEDULED_MODEL_CALLS);
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
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
