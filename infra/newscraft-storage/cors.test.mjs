import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('matches a comma-separated CORS allowlist and varies only allowed origins', async () => {
	const root = await mkdtemp(join(tmpdir(), 'newscraft-storage-cors-'));
	const port = 19100 + (process.pid % 500);
	const child = spawn(process.execPath, ['server.mjs'], {
		cwd: join(process.cwd(), 'infra', 'newscraft-storage'),
		env: {
			...process.env,
			PORT: String(port),
			NEWSCRAFT_STORAGE_ROOT: root,
			NEWSCRAFT_STORAGE_API_KEY: 'test-storage-key',
			NEWSCRAFT_STORAGE_SIGNING_KEY: 'test-signing-key-that-is-at-least-32-bytes',
			NEWSCRAFT_STORAGE_PUBLIC_URL: 'https://files.example.test/newscraft-storage',
			NEWSCRAFT_STORAGE_CORS_ORIGIN: 'https://agent.newscraftai.com, https://preview.newscraftai.com'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk; });
	child.stderr.on('data', (chunk) => { output += chunk; });
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error(`storage server did not start: ${output}`)), 5000);
			child.stdout.on('data', (chunk) => {
				if (String(chunk).includes('newscraft storage listening')) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.once('error', reject);
			child.once('exit', (code) => {
				if (code !== null && code !== 0) reject(new Error(`storage server exited ${code}: ${output}`));
			});
		});

		for (const origin of ['https://agent.newscraftai.com', 'https://preview.newscraftai.com']) {
			const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { method: 'OPTIONS', headers: { origin } });
			assert.equal(response.status, 204);
			assert.equal(response.headers.get('access-control-allow-origin'), origin);
			assert.equal(response.headers.get('vary'), 'origin');
		}
		const rejected = await fetch(`http://127.0.0.1:${port}/v1/health`, { method: 'OPTIONS', headers: { origin: 'https://attacker.example' } });
		assert.equal(rejected.status, 204);
		assert.equal(rejected.headers.get('access-control-allow-origin'), null);
		assert.equal(rejected.headers.get('vary'), 'origin');
	} finally {
		child.kill('SIGTERM');
		await new Promise((resolve) => child.once('exit', resolve));
		await rm(root, { recursive: true, force: true });
	}
});
