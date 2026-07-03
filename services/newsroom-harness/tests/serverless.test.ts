import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVercelHarnessHandler } from '../src/serverless.js';

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	originalEnv = { ...process.env };
});

afterEach(() => {
	process.env = originalEnv;
});

async function invokeServerless(
	method: string,
	url: string,
	env: Record<string, string | undefined> = {}
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
	process.env = { ...originalEnv, ...env };
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
	}

	const req = Object.assign(new EventEmitter(), {
		method,
		url,
		headers: { host: 'newscraft-harness.test' }
	});
	const res = Object.assign(new EventEmitter(), {
		headersSent: false,
		writableEnded: false,
		status: 0,
		body: '',
		headers: {} as Record<string, string>,
		writeHead(status: number, headers: Record<string, string>) {
			this.status = status;
			this.headers = headers;
			this.headersSent = true;
		},
		end(body = '') {
			this.body = String(body);
			this.writableEnded = true;
			this.emit('finish');
		},
		destroy(err?: Error) {
			if (err) this.emit('error', err);
		}
	});

	await createVercelHarnessHandler()(req as never, res as never);
	return { status: res.status, body: res.body, headers: res.headers };
}

const invalidDeployedEnv = {
	NODE_ENV: 'production',
	VERCEL: '1',
	NEWSROOM_HARNESS_API_KEY: undefined
};

describe('serverless newsroom harness handler', () => {
	it('returns unhealthy config as HTTP 503 from /health', async () => {
		const response = await invokeServerless('GET', '/health', invalidDeployedEnv);
		const body = JSON.parse(response.body);

		expect(response.status).toBe(503);
		expect(body.ok).toBe(false);
		expect(body.config.errors).toContain(
			'NEWSROOM_HARNESS_API_KEY is required for deployed harness private endpoints.'
		);
	});

	it('refuses private routes when deployed without required config', async () => {
		const response = await invokeServerless('POST', '/v1/responses', invalidDeployedEnv);

		expect(response.status).toBe(503);
		expect(response.body).toContain('harness is not configured');
	});
});
