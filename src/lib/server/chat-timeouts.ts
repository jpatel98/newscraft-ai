// End the stream before Vercel's 300-second function limit so NewsCraft can
// persist a clear Hermes timeout instead of losing the response at the edge.
const DEFAULT_STREAM_MAX_MS = 290_000;
const DEFAULT_STREAM_IDLE_MS = 90_000;
const DEFAULT_CONTEXT_MS = 10_000;
const DEFAULT_PERSISTENCE_MS = 5_000;
const DEFAULT_TITLE_MS = 5_000;

function envDuration(name: string, fallback: number, minimum: number, maximum: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}

export const CHAT_STREAM_MAX_MS = envDuration(
	'NEWSCRAFT_CHAT_STREAM_MAX_MS',
	DEFAULT_STREAM_MAX_MS,
	10_000,
	290_000
);
export const CHAT_STREAM_IDLE_MS = envDuration(
	'NEWSCRAFT_CHAT_STREAM_IDLE_MS',
	DEFAULT_STREAM_IDLE_MS,
	5_000,
	2 * 60_000
);
export const CHAT_RESEARCH_CONTEXT_TIMEOUT_MS = envDuration(
	'NEWSCRAFT_CHAT_CONTEXT_TIMEOUT_MS',
	DEFAULT_CONTEXT_MS,
	500,
	30_000
);
export const CHAT_PERSISTENCE_TIMEOUT_MS = envDuration(
	'NEWSCRAFT_CHAT_PERSISTENCE_TIMEOUT_MS',
	DEFAULT_PERSISTENCE_MS,
	500,
	30_000
);
export const CHAT_TITLE_TIMEOUT_MS = envDuration(
	'NEWSCRAFT_CHAT_TITLE_TIMEOUT_MS',
	DEFAULT_TITLE_MS,
	500,
	30_000
);

export class ChatPhaseTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TimeoutError';
	}
}

export function withChatTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ChatPhaseTimeoutError(`${label} timed out`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export function linkChatAbort(
	requestSignal: AbortSignal,
	timeoutMs: number
): {
	controller: AbortController;
	timedOut: () => boolean;
	cleanup: () => void;
} {
	const controller = new AbortController();
	let timedOut = false;
	const onRequestAbort = () => controller.abort(requestSignal.reason);
	if (requestSignal.aborted) onRequestAbort();
	else requestSignal.addEventListener('abort', onRequestAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new ChatPhaseTimeoutError('interactive chat stream timed out'));
	}, timeoutMs);
	return {
		controller,
		timedOut: () => timedOut,
		cleanup: () => {
			clearTimeout(timer);
			requestSignal.removeEventListener('abort', onRequestAbort);
		}
	};
}

export function createChatIdleWatchdog(
	controller: AbortController,
	timeoutMs: number
): {
	activity: () => void;
	toolStarted: (id: string) => void;
	toolFinished: (id: string) => void;
	hasActiveTools: () => boolean;
	timedOut: () => boolean;
	cleanup: () => void;
} {
	const activeTools = new Set<string>();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clear = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const arm = () => {
		clear();
		if (activeTools.size > 0 || controller.signal.aborted) return;
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new ChatPhaseTimeoutError('interactive chat stream became idle'));
		}, timeoutMs);
	};
	return {
		activity: arm,
		toolStarted: (id) => {
			activeTools.add(id);
			clear();
		},
		toolFinished: (id) => {
			activeTools.delete(id);
			arm();
		},
		hasActiveTools: () => activeTools.size > 0,
		timedOut: () => timedOut,
		cleanup: clear
	};
}
