import { defineConfig, devices } from '@playwright/test';

const e2eEnv = {
	DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
	APP_SESSION_SECRET: 'aGVybWVzLXVpLWUyZS1zZXNzaW9uLXNlY3JldC0wMDAwMDAwMDAwMDAwMDAw',
	HERMES_GATEWAY_URL: 'http://127.0.0.1:9',
	HERMES_API_KEY: 'e2e-key'
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
