import { env } from '$env/dynamic/private';
import { createHash } from 'node:crypto';
import type {
	GatewayChatCompletionRequest,
	GatewayChatMessage,
	GatewayContent,
	GatewayContentPart,
	GatewayResponseContentPart,
	GatewayResponseInputMessage,
	GatewayResponsesRequest
} from '@newscraft/shared';

export type AgentContentPart = GatewayContentPart;
export type AgentContent = GatewayContent;
export type AgentMessage = GatewayChatMessage;
export type AgentChatRequest = GatewayChatCompletionRequest;
export type AgentResponseContentPart = GatewayResponseContentPart;
export type AgentResponseInputMessage = GatewayResponseInputMessage;
export type AgentResponsesRequest = GatewayResponsesRequest;

export interface GatewayHealth {
	ok: boolean;
	status: number;
	body: string;
	url: string;
	json: unknown | null;
	service: string | null;
}

const DEFAULT_MODEL = 'newsroom-agent';

function gatewayUrl(): string {
	const u = (env.AGENT_GATEWAY_URL || '').replace(/\/$/, '');
	return u || 'http://127.0.0.1:8650';
}

function gatewayEnvHint(): string {
	return 'AGENT_GATEWAY_URL';
}

export function describeGatewayError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message === 'fetch failed' || message === 'Failed to fetch' || message === 'Load failed') {
		return `Agent gateway is not reachable at ${gatewayUrl()}. Start the gateway or update ${gatewayEnvHint()}.`;
	}
	if (
		err instanceof DOMException &&
		(err.name === 'TimeoutError' || err.name === 'AbortError')
	) {
		return `Agent gateway did not respond in time at ${gatewayUrl()}.`;
	}
	return message;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseJson(value: string): unknown | null {
	if (!value.trim()) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function isLoopbackUrl(value: string): boolean {
	try {
		const { hostname } = new URL(value);
		return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
	} catch {
		return false;
	}
}

function apiKey(): string | null {
	const k = env.AGENT_GATEWAY_API_KEY || env.NEWSROOM_HARNESS_API_KEY;
	if (k) return k;
	// A remote gateway without a key is always a misconfiguration; a loopback
	// dev gateway may legitimately run without auth (.env.example default).
	if (env.AGENT_GATEWAY_URL && !isLoopbackUrl(env.AGENT_GATEWAY_URL)) {
		throw new Error('AGENT_GATEWAY_URL is configured but AGENT_GATEWAY_API_KEY or NEWSROOM_HARNESS_API_KEY is missing');
	}
	return null;
}

export async function agentFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	const key = apiKey();
	if (key && !headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

	const suffix = path.startsWith('/') ? path : `/${path}`;
	return fetch(`${gatewayUrl()}${suffix}`, { ...init, headers });
}

/**
 * Deterministic session id from (system prompt, first user message).
 * Lets Agent pin the agent across turns without exposing the key choice
 * to the browser. Capped at 32 hex chars.
 */
export function deriveSessionId(messages: AgentMessage[], scope = ''): string {
	const system = flattenContent(messages.find((m) => m.role === 'system')?.content);
	const firstUser = flattenContent(messages.find((m) => m.role === 'user')?.content);
	return createHash('sha256')
		.update(scope)
		.update('\0')
		.update(system)
		.update('\0')
		.update(firstUser)
		.digest('hex')
		.slice(0, 32);
}

function flattenContent(c: AgentContent | undefined): string {
	if (!c) return '';
	if (typeof c === 'string') return c;
	return c
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('\n');
}

/**
 * POST /v1/chat/completions on the Agent gateway with SSE streaming.
 * Returns the raw fetch Response — the caller pipes body through to the
 * client. AbortSignal propagation triggers Agent's interrupt-on-disconnect.
 */
export async function streamChatCompletion(
	body: AgentChatRequest,
	opts: { signal?: AbortSignal; sessionId?: string } = {}
): Promise<Response> {
	const sessionId = opts.sessionId ?? deriveSessionId(body.messages);
	const payload: AgentChatRequest = { model: DEFAULT_MODEL, stream: true, ...body };
	const key = apiKey();

	return fetch(`${gatewayUrl()}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'text/event-stream',
			...(key ? { authorization: `Bearer ${key}` } : {}),
			'x-agent-session-id': sessionId
		},
		body: JSON.stringify(payload),
		signal: opts.signal
	});
}

export async function streamResponse(
	body: AgentResponsesRequest,
	opts: { signal?: AbortSignal; sessionId?: string } = {}
): Promise<Response> {
	const payload: AgentResponsesRequest = { model: DEFAULT_MODEL, stream: true, store: false, ...body };
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'text/event-stream'
	};
	const key = apiKey();
	if (key) headers.authorization = `Bearer ${key}`;
	if (opts.sessionId) headers['x-agent-session-id'] = opts.sessionId;

	return fetch(`${gatewayUrl()}/v1/responses`, {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
		signal: opts.signal
	});
}

/**
 * Non-streaming completion. Used for short side calls (title summarization).
 * Idempotency-Key keeps Agent from charging twice on retries.
 */
export async function completion(
	body: AgentChatRequest,
	opts: { signal?: AbortSignal; idempotencyKey?: string } = {}
): Promise<unknown> {
	const payload: AgentChatRequest = { model: DEFAULT_MODEL, ...body, stream: false };
	const headers: Record<string, string> = {
		'content-type': 'application/json'
	};
	const key = apiKey();
	if (key) headers.authorization = `Bearer ${key}`;
	if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

	const r = await fetch(`${gatewayUrl()}/v1/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
		signal: opts.signal
	});
	if (!r.ok) throw new Error(`Agent ${r.status}: ${await r.text()}`);
	return r.json();
}

export async function gatewayHealth(): Promise<GatewayHealth> {
	const url = gatewayUrl();
	try {
		const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
		const body = await r.text();
		const parsed = parseJson(body);
		const parsedObject = objectValue(parsed);
		const reportedOk = typeof parsedObject?.ok === 'boolean' ? parsedObject.ok : true;
		const service = typeof parsedObject?.service === 'string' ? parsedObject.service : null;
		return { ok: r.ok && reportedOk, status: r.status, body, json: parsed, service, url };
	} catch (e) {
		return { ok: false, status: 0, body: describeGatewayError(e), json: null, service: null, url };
	}
}
