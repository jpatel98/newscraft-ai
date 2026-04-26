import { env } from '$env/dynamic/private';
import { createHash } from 'node:crypto';

export type HermesContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export type HermesContent = string | HermesContentPart[];

export type HermesMessage =
	| { role: 'system' | 'user' | 'assistant'; content: HermesContent }
	| { role: 'tool'; content: string; tool_call_id?: string };

export interface HermesChatRequest {
	messages: HermesMessage[];
	model?: string;
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
}

const DEFAULT_MODEL = 'hermes-agent';

function gatewayUrl(): string {
	const u = env.HERMES_GATEWAY_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:8642';
	return u;
}

function apiKey(): string {
	const k = env.HERMES_API_KEY;
	if (!k) throw new Error('HERMES_API_KEY not configured');
	return k;
}

export async function hermesFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has('authorization')) headers.set('authorization', `Bearer ${apiKey()}`);
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

	const suffix = path.startsWith('/') ? path : `/${path}`;
	return fetch(`${gatewayUrl()}${suffix}`, { ...init, headers });
}

/**
 * Deterministic session id from (system prompt, first user message).
 * Lets Hermes pin the agent across turns without exposing the key choice
 * to the browser. Capped at 32 hex chars.
 */
export function deriveSessionId(messages: HermesMessage[]): string {
	const system = flattenContent(messages.find((m) => m.role === 'system')?.content);
	const firstUser = flattenContent(messages.find((m) => m.role === 'user')?.content);
	return createHash('sha256').update(system).update('\0').update(firstUser).digest('hex').slice(0, 32);
}

function flattenContent(c: HermesContent | undefined): string {
	if (!c) return '';
	if (typeof c === 'string') return c;
	return c
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('\n');
}

/**
 * POST /v1/chat/completions on the Hermes gateway with SSE streaming.
 * Returns the raw fetch Response — the caller pipes body through to the
 * client. AbortSignal propagation triggers Hermes's interrupt-on-disconnect.
 */
export async function streamChatCompletion(
	body: HermesChatRequest,
	opts: { signal?: AbortSignal; sessionId?: string } = {}
): Promise<Response> {
	const sessionId = opts.sessionId ?? deriveSessionId(body.messages);
	const payload: HermesChatRequest = { model: DEFAULT_MODEL, stream: true, ...body };

	return fetch(`${gatewayUrl()}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'text/event-stream',
			authorization: `Bearer ${apiKey()}`,
			'x-hermes-session-id': sessionId
		},
		body: JSON.stringify(payload),
		signal: opts.signal
	});
}

/**
 * Non-streaming completion. Used for short side calls (title summarization).
 * Idempotency-Key keeps Hermes from charging twice on retries.
 */
export async function completion(
	body: HermesChatRequest,
	opts: { signal?: AbortSignal; idempotencyKey?: string } = {}
): Promise<unknown> {
	const payload: HermesChatRequest = { model: DEFAULT_MODEL, ...body, stream: false };
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		authorization: `Bearer ${apiKey()}`
	};
	if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

	const r = await fetch(`${gatewayUrl()}/v1/chat/completions`, {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
		signal: opts.signal
	});
	if (!r.ok) throw new Error(`Hermes ${r.status}: ${await r.text()}`);
	return r.json();
}

export async function gatewayHealth(): Promise<{ ok: boolean; status: number; body: string }> {
	try {
		const r = await fetch(`${gatewayUrl()}/health`, { signal: AbortSignal.timeout(2000) });
		return { ok: r.ok, status: r.status, body: await r.text() };
	} catch (e) {
		return { ok: false, status: 0, body: String(e) };
	}
}
