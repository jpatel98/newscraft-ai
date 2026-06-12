import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const e2eEnv = {
	DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
	APP_SESSION_SECRET: 'aGVybWVzLXVpLWUyZS1zZXNzaW9uLXNlY3JldC0wMDAwMDAwMDAwMDAwMDAw',
	AGENT_GATEWAY_URL: 'http://127.0.0.1:9',
	AGENT_GATEWAY_API_KEY: 'e2e-key',
	// Activates /api/e2e/seed so the suite can provision a test account on
	// both fresh and pre-seeded databases. Never set this in production.
	E2E_SECRET: process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret'
};

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	expect: {
		timeout: 7_500
	},
	reporter: [['list']],
	globalSetup: './tests/e2e/global-setup.ts',
	use: {
		baseURL: 'http://127.0.0.1:4174',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure'
	},
	webServer: {
		command: 'pnpm dev --host 127.0.0.1 --port 4174',
		url: 'http://127.0.0.1:4174',
		timeout: 30_000,
		reuseExistingServer: false,
		env: e2eEnv
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		}
	]
});
