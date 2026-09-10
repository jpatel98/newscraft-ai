export interface MarkdownStreamRender {
	content: string;
	partial: boolean;
}

export interface MarkdownStreamSchedulerOptions {
	requestAnimationFrame?: (callback: () => void) => number;
	cancelAnimationFrame?: (handle: number) => void;
	setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
	frameDelayMs?: number;
}

export interface MarkdownStreamScheduler {
	update(content: string, partial: boolean): void;
	flush(): void;
	destroy(): void;
}

/**
	Coalesce partial Markdown updates to one render per frame while making
	terminal updates synchronous. The injected clock hooks keep this state
	machine deterministic in tests and safe to use during SSR.
*/
export function createMarkdownStreamScheduler(
	onRender: (render: MarkdownStreamRender) => void,
	options: MarkdownStreamSchedulerOptions = {}
): MarkdownStreamScheduler {
	const requestFrame = options.requestAnimationFrame ?? defaultRequestAnimationFrame();
	const cancelFrame = options.cancelAnimationFrame ?? defaultCancelAnimationFrame();
	const scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearScheduledTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle));
	const frameDelayMs = options.frameDelayMs ?? 16;

	let pendingContent = '';
	let pendingPartial = false;
	let frame: number | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	function cancelPending(): void {
		if (frame !== null) {
			cancelFrame?.(frame);
			frame = null;
		}
		if (timer !== null) {
			clearScheduledTimeout(timer);
			timer = null;
		}
	}

	function flush(): void {
		if (destroyed) return;
		cancelPending();
		onRender({ content: pendingContent, partial: pendingPartial });
	}

	function schedule(): void {
		if (frame !== null || timer !== null || destroyed) return;
		if (requestFrame) {
			frame = requestFrame(() => {
				frame = null;
				flush();
			});
			return;
		}
		timer = scheduleTimeout(() => {
			timer = null;
			flush();
		}, frameDelayMs);
	}

	return {
		update(content, partial) {
			if (destroyed) return;
			pendingContent = content;
			pendingPartial = partial;
			if (partial) schedule();
			else flush();
		},
		flush,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			cancelPending();
		}
	};
}

function defaultRequestAnimationFrame(): ((callback: () => void) => number) | undefined {
	return typeof globalThis.requestAnimationFrame === 'function'
		? globalThis.requestAnimationFrame.bind(globalThis)
		: undefined;
}

function defaultCancelAnimationFrame(): ((handle: number) => void) | undefined {
	return typeof globalThis.cancelAnimationFrame === 'function'
		? globalThis.cancelAnimationFrame.bind(globalThis)
		: undefined;
}
