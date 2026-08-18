import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));

import { streamChatCompletion } from './transport';

function readinessFixture() {
	return {
		ok: true,
		service: 'newscraft-hermes-chat',
		toolset: 'hermes-acp',
		tools: ['browser_navigate', 'browser_snapshot', 'web_extract', 'verify_this_lead'],
		runtime: { provider: 'custom', model: 'safe-fixture', endpointMode: 'explicit' },
		capabilities: {
			standard: true,
			browser: true,
			webResearch: true,
			terminal: true,
			files: true,
			codeExecution: true,
			delegation: true,
			skills: true,
			memory: true,
			accountIsolation: {
				tenantHeader: 'x-newscraft-tenant-key',
				contextLocalHome: true,
				stableTaskKey: true,
				persistentDockerWorkspace: true,
				isolatedBrowserProfiles: true
			},
			webExtraction: {
				configured: true,
				backend: 'newscraft-local',
				archiveProvider: 'wayback',
				tool: true,
				leadVerificationTool: true
			},
			webLeadVerification: { configured: true, tool: true, bounded: true }
		}
	};
}

async function readBody(request: IncomingMessage): Promise<string> {
	request.setEncoding('utf8');
	let body = '';
	for await (const chunk of request) body += chunk;
	return body;
}

describe('NewsCraft app server to Hermes boundary', () => {
	const originalUrl = process.env.NEWSCRAFT_HERMES_URL;
	const originalToken = process.env.NEWSCRAFT_HERMES_API_TOKEN;
	const originalTenantSecret = process.env.NEWSCRAFT_HERMES_TENANT_SECRET;
	let server: Server;
	let baseUrl = '';
	let ready = readinessFixture();
	let readyRequests = 0;
	let chatRequests = 0;
	let receivedHeaders: IncomingMessage['headers'] = {};
	let receivedBody = '';

	beforeEach(async () => {
		ready = readinessFixture();
		readyRequests = 0;
		chatRequests = 0;
		receivedHeaders = {};
		receivedBody = '';
		server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
			if (request.method === 'GET' && request.url === '/ready') {
				readyRequests += 1;
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify(ready));
				return;
			}
			if (request.method === 'POST' && request.url === '/') {
				chatRequests += 1;
				receivedHeaders = request.headers;
				receivedBody = await readBody(request);
				response.writeHead(200, { 'content-type': 'text/event-stream' });
				response.end(
					[
						{ type: 'TEXT_MESSAGE_START', messageId: 'fixture-answer', role: 'assistant' },
						{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'fixture-answer', delta: 'Fixture reply.' },
						{ type: 'TEXT_MESSAGE_END', messageId: 'fixture-answer' },
						{ type: 'RUN_FINISHED' }
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join('')
				);
				return;
			}
			response.writeHead(404).end();
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
		baseUrl = `http://127.0.0.1:${address.port}`;
		process.env.NEWSCRAFT_HERMES_URL = baseUrl;
		process.env.NEWSCRAFT_HERMES_API_TOKEN = 'fixture-session-token';
		process.env.NEWSCRAFT_HERMES_TENANT_SECRET = 'fixture-tenant-secret-0123456789012345';
	});

	afterEach(async () => {
		if (originalUrl === undefined) delete process.env.NEWSCRAFT_HERMES_URL;
		else process.env.NEWSCRAFT_HERMES_URL = originalUrl;
		if (originalToken === undefined) delete process.env.NEWSCRAFT_HERMES_API_TOKEN;
		else process.env.NEWSCRAFT_HERMES_API_TOKEN = originalToken;
		if (originalTenantSecret === undefined) delete process.env.NEWSCRAFT_HERMES_TENANT_SECRET;
		else process.env.NEWSCRAFT_HERMES_TENANT_SECRET = originalTenantSecret;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
	});

	it('proves readiness and chat through the authenticated server-only boundary', async () => {
		const response = await streamChatCompletion(
			{ messages: [{ role: 'user', content: 'Use the fixture boundary.' }] },
			{ accountId: 'account-fixture', sessionId: 'conversation-fixture', requireWebExtraction: true }
		);
		const stream = await response.text();

		expect(readyRequests).toBe(1);
		expect(chatRequests).toBe(1);
		expect(receivedHeaders.authorization).toBe('Bearer fixture-session-token');
		expect(receivedHeaders['x-hermes-session-token']).toBe('fixture-session-token');
		expect(receivedHeaders['x-newscraft-tenant-key']).toMatch(/^[A-Za-z0-9_-]{32,}$/);
		expect(receivedHeaders['x-newscraft-tenant-key']).not.toContain('account-fixture');
		expect(receivedBody).not.toContain('account-fixture');
		expect(stream).toContain('Fixture reply.');
		expect(stream).toContain('data: [DONE]');
	});

	it('does not send chat when one required readiness contract fails', async () => {
		ready.capabilities.accountIsolation.stableTaskKey = false;

		await expect(
			streamChatCompletion(
				{ messages: [{ role: 'user', content: 'This must not reach Hermes.' }] },
				{ accountId: 'account-fixture', sessionId: 'conversation-fixture' }
			)
		).rejects.toThrow('account isolation is not ready');

		expect(readyRequests).toBe(1);
		expect(chatRequests).toBe(0);
	});
});
