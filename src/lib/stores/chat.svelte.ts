// Cross-component chat session state. Holds the in-flight AbortController so
// keyboard shortcuts (Esc) can cancel a stream the composer started.
//
// Also holds the ephemeral tool-progress strip + the "edit-last" handoff used
// by the ↑ keyboard shortcut to recall the previous user message.

export interface ToolProgress {
	id: string;
	name: string;
	emoji?: string;
	startedAt: number;
	detail?: string;
	url?: string;
	title?: string;
	status?: string;
}

export interface ToolHistoryEntry {
	id: string;
	name: string;
	startedAt: number;
	finishedAt: number;
	detail?: string;
	url?: string;
	title?: string;
	status?: string;
}

export interface SourceProgress {
	id: string;
	url: string;
	title: string;
	status: 'queued' | 'reading' | 'used' | 'skipped' | 'error' | string;
	domain: string;
	detail?: string;
	updatedAt: number;
}

class ChatSession {
	abort = $state<AbortController | null>(null);
	abortIntent = $state<'stop' | 'partial' | null>(null);
	tools = $state<ToolProgress[]>([]);
	sources = $state<SourceProgress[]>([]);
	// Names of tools that completed during the current run. Cleared on the
	// next startStream so each turn shows its own summary; powers the
	// "Sources checked" recap that replaces the live activity component.
	toolHistory = $state<ToolHistoryEntry[]>([]);
	streamStartedAt = $state<number | null>(null);
	streaming = $state(false);
	editRequest = $state<string | null>(null); // populated by ↑; consumed by Composer
	lastUserContent = $state<string | null>(null); // set by the active conversation page; read by ↑ handler

	startStream(): AbortController {
		// If a stream is already in flight, abort it so the next one can take
		// over cleanly. The previous runStream's finally clause will detect
		// that the active controller has changed and skip the state reset.
		if (this.abort && !this.abort.signal.aborted) {
			this.abort.abort();
		}
		const c = new AbortController();
		this.abort = c;
		this.abortIntent = null;
		this.streaming = true;
		this.tools = [];
		this.sources = [];
		this.toolHistory = [];
		this.streamStartedAt = Date.now();
		return c;
	}

	endStream() {
		this.abort = null;
		this.abortIntent = null;
		this.streaming = false;
		this.tools = [];
		this.streamStartedAt = null;
		// Keep toolHistory so the recap stays visible against the latest
		// assistant message until the next stream begins.
	}

	cancel(intent: 'stop' | 'partial' = 'stop') {
		this.abortIntent = intent;
		if (this.abort) {
			this.abort.abort();
		}
		this.tools = [];
	}

	pushTool(t: ToolProgress) {
		const existing = this.tools.find((tool) => tool.id === t.id);
		if (existing) {
			this.tools = this.tools.map((tool) => (tool.id === t.id ? { ...tool, ...t } : tool));
		} else {
			this.tools = [...this.tools, t];
		}
		if (t.url) {
			this.pushSource({
				id: t.url,
				url: t.url,
				title: t.title || t.url,
				status: normalizeSourceStatus(t.status),
				domain: domainOf(t.url),
				detail: t.detail,
				updatedAt: Date.now()
			});
		}
	}

	clearTool(id: string) {
		const finished = this.tools.find((t) => t.id === id);
		this.tools = this.tools.filter((t) => t.id !== id);
		if (finished) {
			this.toolHistory = [
				...this.toolHistory,
				{
					id: finished.id,
					name: finished.name,
					startedAt: finished.startedAt,
					finishedAt: Date.now(),
					detail: finished.detail,
					url: finished.url,
					title: finished.title,
					status: finished.status
				}
			];
		}
	}

	pushSource(source: SourceProgress) {
		const byUrl = this.sources.find((s) => s.url === source.url || s.id === source.id);
		if (byUrl) {
			this.sources = this.sources.map((s) =>
				s.url === source.url || s.id === source.id ? { ...s, ...source, id: s.id } : s
			);
		} else {
			this.sources = [...this.sources, source].slice(-8);
		}
	}

	requestEdit(content: string) {
		this.editRequest = content;
	}

	consumeEdit(): string | null {
		const v = this.editRequest;
		this.editRequest = null;
		return v;
	}
}

export const chat = new ChatSession();

function normalizeSourceStatus(status: string | undefined): SourceProgress['status'] {
	const value = (status || 'reading').toLowerCase();
	if (['done', 'complete', 'completed', 'success', 'ok'].includes(value)) return 'used';
	if (['start', 'started', 'running', 'open', 'fetch'].includes(value)) return 'reading';
	return value;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}
