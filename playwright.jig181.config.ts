import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JIG181_VIEWPORTS } from './scripts/jig-181-ui-matrix-contract.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.JIG181_E2E_DATABASE_URL?.trim();

if (process.env.JIG181_UI_MATRIX_RUN !== '1' || process.env.JIG181_E2E_AUTHORIZED !== '1') {
	throw new Error('JIG-181 Playwright config requires the matrix runner and explicit database authority');
}
if (!databaseUrl) throw new Error('JIG-181 Playwright config requires an explicitly supplied disposable database URL');

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/jig-181-ui-matrix.spec.ts',
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	expect: { timeout: 7_500 },
	reporter: [
		[
			path.resolve(repoRoot, 'scripts/jig-181-playwright-reporter.mjs'),
			{
				output: process.env.JIG181_EVIDENCE_OUTPUT,
				evidenceDir: process.env.JIG181_EVIDENCE_DIR
			}
		]
	],
	globalSetup: './tests/e2e/jig-181-global-setup.ts',
	use: {
		baseURL: 'http://127.0.0.1:4174',
		trace: 'retain-on-failure',
		screenshot: 'off'
	},
	webServer: {
		command: 'pnpm dev --host 127.0.0.1 --port 4174 --strictPort',
		url: 'http://127.0.0.1:4174',
		timeout: 30_000,
		reuseExistingServer: false,
		env: {
			DATABASE_URL: databaseUrl,
			NEWSCRAFT_TEST_DATABASE_URL: databaseUrl,
			APP_SESSION_SECRET: 'aGVybWVzLXVpLWUyZS1zZXNzaW9uLXNlY3JldC0wMDAwMDAwMDAwMDAwMDAw',
			AGENT_GATEWAY_URL: 'http://127.0.0.1:9',
			AGENT_GATEWAY_API_KEY: 'jig181-local-fixture',
			NEWSCRAFT_HERMES_URL: 'http://127.0.0.1:9',
			E2E_SECRET: 'newscraft-jig181-local-secret'
		}
	},
	projects: JIG181_VIEWPORTS.map((viewport) => ({
		name: `jig181-${viewport.id}`,
		use: {
			...devices['Desktop Chrome'],
			viewport: { width: viewport.width, height: viewport.height },
			reducedMotion: 'no-preference'
		}
	}))
});
