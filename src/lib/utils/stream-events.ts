export interface StreamToolCall {
	id: string;
	name: string;
	status?: 'running' | 'ok' | 'failed' | 'unknown' | string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	arguments?: unknown;
	result?: unknown;
	transcript?: string;
	detail?: string;
	url?: string;
	title?: string;
}

export interface StreamToolUpdate extends StreamToolCall {
	done?: boolean;
}

export interface StreamSourceUpdate {
	id: string;
	url: string;
	title: string;
	status: string;
	domain?: string;
	detail?: string;
}

export interface StreamEventUpdate {
	delta?: string;
	done?: boolean;
	failed?: string;
	title?: string;
	tool?: StreamToolUpdate;
	source?: StreamSourceUpdate;
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		const text = stringValue(value);
		if (text) return text;
	}
	return null;
}

function rawString(value: unknown): string | null {
	return typeof value === 'string' ? value : stringValue(value);
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseJsonObject(data: string): JsonObject | null {
	try {
		return objectValue(JSON.parse(data));
	} catch {
		return null;
	}
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!/^[{[]/.test(trimmed)) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function statusValue(value: unknown, fallback = 'running'): StreamToolCall['status'] {
	const raw = stringValue(value)?.toLowerCase() ?? fallback;
	if (['done', 'end', 'complete', 'completed', 'success', 'ok'].includes(raw)) return 'ok';
	if (['failed', 'failure', 'error', 'errored'].includes(raw)) return 'failed';
	if (['start', 'started', 'running', 'active', 'in_progress', 'progress', 'queued', 'pending'].includes(raw)) {
		return 'running';
	}
	return raw;
}

function isTerminalStatus(value: unknown): boolean {
	const raw = stringValue(value)?.toLowerCase();
	if (!raw) return false;
	return [
		'done',
		'end',
		'complete',
		'completed',
		'success',
		'ok',
		'failed',
		'failure',
		'error',
		'errored'
	].includes(raw);
}

function isStartLikeStatus(value: unknown): boolean {
	const raw = stringValue(value)?.toLowerCase();
	if (!raw) return true;
	return ['start', 'started', 'queued', 'pending', 'open', 'fetch', 'reading'].includes(raw);
}

function domainOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return undefined;
	}
}

function sourceFromPayload(payload: JsonObject): StreamSourceUpdate | null {
	const nested = objectValue(payload.source) ?? objectValue(payload.url) ?? null;
	const source = nested ?? payload;
	const url = stringValue(source.url ?? source.href ?? source.link ?? source.uri);
	if (!url || !/^https?:\/\//i.test(url)) return null;
	const title =
		stringValue(source.title ?? source.name ?? source.label) ||
		stringValue(payload.title ?? payload.name) ||
		url;
	return {
		id: stringValue(source.id ?? payload.id) || url,
		url,
		title,
		status: stringValue(source.status ?? payload.status ?? payload.phase) || 'reading',
		domain: stringValue(source.domain ?? payload.domain) ?? domainOf(url),
		detail:
			stringValue(source.detail ?? source.summary ?? source.snippet ?? payload.detail ?? payload.message) ??
			undefined
	};
}

function chatDelta(payload: JsonObject): string {
	const choices = arrayValue(payload.choices);
	const first = objectValue(choices[0]);
	const delta = objectValue(first?.delta);
	const message = objectValue(first?.message);
	return rawString(delta?.content ?? message?.content) ?? '';
}

function chatFinished(payload: JsonObject): boolean {
	const choices = arrayValue(payload.choices);
	return choices.some((choice) => objectValue(choice)?.finish_reason != null);
}

function outputTextFromContentPart(part: unknown): string {
	const obj = objectValue(part);
	if (!obj) return '';
	const type = stringValue(obj.type);
	if (type === 'output_text' || type === 'text') return rawString(obj.text) ?? '';
	return '';
}

function outputTextFromItem(item: unknown): string {
	const obj = objectValue(item);
	if (!obj) return '';
	const type = stringValue(obj.type);
	if (type === 'message') return arrayValue(obj.content).map(outputTextFromContentPart).join('');
	if (type === 'output_text') return rawString(obj.text) ?? '';
	return '';
}

function outputTextFromResponse(response: JsonObject): string {
	return arrayValue(response.output).map(outputTextFromItem).join('');
}

export function sseFrame(event: string, data: string): string {
	let out = event && event !== 'message' ? `event: ${event}\n` : '';
	for (const line of data.split(/\r?\n/)) out += `data: ${line}\n`;
	return `${out}\n`;
}

export class StreamEventState {
	private calls = new Map<string, StreamToolCall>();
	private itemToCall = new Map<string, string>();
	private argumentText = new Map<string, string>();
	private anonymousActive = new Map<string, string>();
	private anonymousKeys = new Map<string, string>();
	private textDeltaSeen = false;
	private seq = 0;

	apply(event: string, data: string, now = Date.now()): StreamEventUpdate[] {
		if (data === '[DONE]') return [{ done: true }];

		const payload = parseJsonObject(data);
		if (event === 'hermes.title' && payload) {
			const title = stringValue(payload.title);
			return title ? [{ title }] : [];
		}
		if (!payload) return [];

		if (event === 'message') {
			const delta = chatDelta(payload);
			const updates: StreamEventUpdate[] = [];
			if (delta) {
				this.textDeltaSeen = true;
				updates.push({ delta });
			}
			if (chatFinished(payload)) updates.push({ done: true });
			return updates;
		}

		if (event === 'hermes.tool.progress') return this.applyHermesTool(payload, now);

		if (event.startsWith('hermes.source') || event.startsWith('hermes.progress')) {
			const source = sourceFromPayload(payload);
			if (source) return [{ source }];
			return this.upsertTool(payload, now).map((tool) => ({ tool }));
		}

		if (event.startsWith('response.')) return this.applyResponseEvent(event, payload, now);

		return [];
	}

	toolCalls(): StreamToolCall[] {
		return Array.from(this.calls.values())
			.map((call) => ({ ...call }))
			.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
	}

	private applyHermesTool(payload: JsonObject, now: number): StreamEventUpdate[] {
		const updates: StreamEventUpdate[] = [];
		const source = sourceFromPayload(payload);
		if (source) updates.push({ source });

		const terminal = isTerminalStatus(payload.status ?? payload.phase);
		for (const tool of this.upsertTool(payload, now)) {
			if (terminal) {
				tool.done = true;
				tool.endedAt ??= now;
			}
			updates.push({ tool });
		}
		return updates;
	}

	private applyResponseEvent(event: string, payload: JsonObject, now: number): StreamEventUpdate[] {
		if (event === 'response.output_text.delta') {
			const delta = rawString(payload.delta) ?? '';
			if (!delta) return [];
			this.textDeltaSeen = true;
			return [{ delta }];
		}

		if (event === 'response.output_item.added' || event === 'response.output_item.done') {
			const item = objectValue(payload.item);
			return item ? this.applyResponseItem(item, event, now) : [];
		}

		if (event === 'response.function_call_arguments.delta') {
			return this.applyArgumentsDelta(payload, now);
		}

		if (event === 'response.function_call_arguments.done') {
			return this.applyArgumentsDone(payload, now);
		}

		if (event === 'response.completed') {
			const response = objectValue(payload.response) ?? payload;
			const updates = arrayValue(response.output).flatMap((item) =>
				this.applyResponseItem(objectValue(item) ?? {}, event, now)
			);
			if (!this.textDeltaSeen) {
				const text = outputTextFromResponse(response);
				if (text) {
					this.textDeltaSeen = true;
					updates.push({ delta: text });
				}
			}
			updates.push({ done: true });
			return updates;
		}

		if (event === 'response.failed' || event === 'response.incomplete') {
			const error = objectValue(payload.error ?? objectValue(payload.response)?.error);
			const detail =
				stringValue(error?.message) ||
				stringValue(payload.message ?? objectValue(payload.response)?.status) ||
				event;
			return [{ failed: detail, done: true }];
		}

		return [];
	}

	private applyResponseItem(item: JsonObject, event: string, now: number): StreamEventUpdate[] {
		const type = stringValue(item.type);
		if (type === 'function_call') {
			const id = this.toolIdFromItem(item);
			const itemId = stringValue(item.id);
			if (itemId) this.itemToCall.set(itemId, id);
			const call = this.ensureTool(id, stringValue(item.name) || 'function_call', now);
			call.name = stringValue(item.name) || call.name;
			call.status = statusValue(item.status, 'running');
			this.applyArgumentsValue(call, item.arguments ?? item.arguments_json);
			if (statusValue(item.status) === 'failed') {
				call.endedAt ??= now;
				return [{ tool: { ...call, done: true } }];
			}
			return [{ tool: { ...call, done: false } }];
		}

		if (type === 'function_call_output') {
			const id = this.toolIdFromItem(item);
			const call = this.ensureTool(id, stringValue(item.name) || 'function_call', now);
			const output = item.output ?? item.result ?? item.content;
			if (output !== undefined) call.result = parseMaybeJson(output);
			call.status = statusValue(item.status, stringValue(item.error) ? 'failed' : 'ok');
			call.detail = stringValue(item.error ?? item.detail ?? item.summary) ?? call.detail;
			call.endedAt ??= now;
			call.durationMs = numberValue(item.duration_ms ?? item.durationMs) ?? call.durationMs;
			return [{ tool: { ...call, done: true } }];
		}

		return [];
	}

	private applyArgumentsDelta(payload: JsonObject, now: number): StreamEventUpdate[] {
		const id = this.toolIdFromPayload(payload);
		if (!id) return [];
		const call = this.ensureTool(id, stringValue(payload.name) || 'function_call', now);
		const delta = rawString(payload.delta) ?? '';
		if (delta) {
			const next = `${this.argumentText.get(id) ?? ''}${delta}`;
			this.argumentText.set(id, next);
			call.arguments = parseMaybeJson(next);
		}
		return [{ tool: { ...call, done: false } }];
	}

	private applyArgumentsDone(payload: JsonObject, now: number): StreamEventUpdate[] {
		const id = this.toolIdFromPayload(payload);
		if (!id) return [];
		const call = this.ensureTool(id, stringValue(payload.name) || 'function_call', now);
		const args = payload.arguments ?? this.argumentText.get(id);
		this.applyArgumentsValue(call, args);
		return [{ tool: { ...call, done: false } }];
	}

	private upsertTool(payload: JsonObject, now: number): StreamToolUpdate[] {
		const nestedTool = objectValue(payload.tool);
		const name =
			firstString(
				payload.name,
				payload.tool,
				payload.tool_name,
				nestedTool?.name,
				nestedTool?.tool_name,
				nestedTool?.type,
				payload.type
			) || 'tool';
		const explicitId = firstString(
			payload.id,
			payload.call_id,
			payload.callId,
			payload.tool_call_id,
			nestedTool?.id,
			nestedTool?.call_id,
			nestedTool?.callId,
			nestedTool?.tool_call_id
		);
		const status = payload.status ?? payload.phase ?? nestedTool?.status ?? nestedTool?.phase;
		const terminal = isTerminalStatus(status);
		const semanticKey = this.semanticToolKey(name, payload, nestedTool);
		const completed: StreamToolUpdate[] = [];
		const id =
			explicitId ?? this.anonymousToolId(name, semanticKey, status, terminal, now, completed);
		const call = this.ensureTool(id, name, now);
		call.name = name;
		call.status = statusValue(status, call.status ?? 'running');
		call.detail =
			firstString(
				payload.detail,
				nestedTool?.detail,
				payload.message,
				nestedTool?.message,
				payload.summary,
				nestedTool?.summary,
				payload.label,
				nestedTool?.label,
				payload.preview,
				nestedTool?.preview,
				payload.error,
				nestedTool?.error
			) ?? call.detail;
		call.url =
			firstString(
				payload.url,
				payload.href,
				payload.link,
				payload.uri,
				nestedTool?.url,
				nestedTool?.href,
				nestedTool?.link,
				nestedTool?.uri
			) ?? call.url;
		call.title = firstString(payload.title, nestedTool?.title, payload.label, nestedTool?.label) ?? call.title;
		call.transcript =
			firstString(payload.transcript, nestedTool?.transcript, payload.preview, nestedTool?.preview) ??
			call.transcript;
		this.applyArgumentsValue(
			call,
			payload.arguments ?? payload.args ?? payload.input ?? nestedTool?.arguments ?? nestedTool?.args ?? nestedTool?.input
		);
		const result =
			payload.result ?? payload.output ?? payload.response ?? nestedTool?.result ?? nestedTool?.output ?? nestedTool?.response;
		if (result !== undefined) call.result = parseMaybeJson(result);
		if (terminal) {
			call.endedAt ??= now;
			if (!explicitId && this.anonymousActive.get(name) === id) {
				this.anonymousActive.delete(name);
			}
		} else if (!explicitId) {
			this.anonymousActive.set(name, id);
			if (semanticKey) this.anonymousKeys.set(id, semanticKey);
		}
		return [...completed, { ...call, done: Boolean(call.endedAt) }];
	}

	private anonymousToolId(
		name: string,
		semanticKey: string,
		status: unknown,
		terminal: boolean,
		now: number,
		completed: StreamToolUpdate[]
	): string {
		const activeId = this.anonymousActive.get(name);
		const active = activeId ? this.calls.get(activeId) : undefined;
		const activeKey = activeId ? (this.anonymousKeys.get(activeId) ?? '') : '';

		if (terminal && active && !active.endedAt) return active.id;

		if (active && !active.endedAt) {
			const sameStep = !semanticKey || !activeKey || semanticKey === activeKey;
			if (sameStep || !isStartLikeStatus(status)) return active.id;

			const finished = this.finishTool(active.id, now);
			if (finished) completed.push(finished);
		}

		const id = `${name}-${++this.seq}`;
		if (semanticKey) this.anonymousKeys.set(id, semanticKey);
		this.anonymousActive.set(name, id);
		return id;
	}

	private semanticToolKey(name: string, payload: JsonObject, nestedTool: JsonObject | null): string {
		const parts = [
			name,
			firstString(payload.url, payload.href, payload.link, payload.uri, nestedTool?.url, nestedTool?.href, nestedTool?.link, nestedTool?.uri),
			firstString(payload.title, nestedTool?.title),
			firstString(payload.detail, nestedTool?.detail),
			firstString(payload.message, nestedTool?.message),
			firstString(payload.summary, nestedTool?.summary),
			firstString(payload.label, nestedTool?.label),
			firstString(payload.preview, nestedTool?.preview),
			this.argumentsKey(payload.arguments ?? payload.args ?? payload.input ?? nestedTool?.arguments ?? nestedTool?.args ?? nestedTool?.input)
		].filter(Boolean);
		return parts.join('\n');
	}

	private argumentsKey(value: unknown): string {
		if (value === undefined || value === null) return '';
		const parsed = parseMaybeJson(value);
		if (typeof parsed === 'string') return parsed.trim();
		try {
			return JSON.stringify(parsed);
		} catch {
			return '';
		}
	}

	private finishTool(id: string, now: number): StreamToolUpdate | null {
		const call = this.calls.get(id);
		if (!call || call.endedAt) return null;
		call.status = statusValue('ok');
		call.endedAt = now;
		return { ...call, done: true };
	}

	private ensureTool(id: string, name: string, now: number): StreamToolCall {
		const existing = this.calls.get(id);
		if (existing) return existing;
		const call: StreamToolCall = { id, name, status: 'running', startedAt: now };
		this.calls.set(id, call);
		return call;
	}

	private toolIdFromItem(item: JsonObject): string {
		return (
			stringValue(item.call_id ?? item.callId ?? item.tool_call_id) ||
			(stringValue(item.id) ? this.itemToCall.get(stringValue(item.id) as string) : null) ||
			stringValue(item.id) ||
			`tool-${++this.seq}`
		);
	}

	private toolIdFromPayload(payload: JsonObject): string | null {
		const callId = stringValue(payload.call_id ?? payload.callId ?? payload.tool_call_id);
		if (callId) return callId;
		const itemId = stringValue(payload.item_id ?? payload.itemId ?? payload.id);
		if (!itemId) return null;
		return this.itemToCall.get(itemId) ?? itemId;
	}

	private applyArgumentsValue(call: StreamToolCall, value: unknown): void {
		if (value === undefined || value === null) return;
		call.arguments = parseMaybeJson(value);
		if (typeof value === 'string') this.argumentText.set(call.id, value);
	}
}
