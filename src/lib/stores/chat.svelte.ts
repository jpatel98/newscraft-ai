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
}

export interface ToolHistoryEntry {
	id: string;
	name: string;
	startedAt: number;
	finishedAt: number;
}

class ChatSession {
	abort = $state<AbortController | null>(null);
	tools = $state<ToolProgress[]>([]);
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
		this.streaming = true;
		this.tools = [];
		this.toolHistory = [];
		this.streamStartedAt = Date.now();
		return c;
	}

	endStream() {
		this.abort = null;
		this.streaming = false;
		this.tools = [];
		this.streamStartedAt = null;
		// Keep toolHistory so the recap stays visible against the latest
		// assistant message until the next stream begins.
	}

	cancel() {
		if (this.abort) {
			this.abort.abort();
		}
		this.tools = [];
	}

	pushTool(t: ToolProgress) {
		this.tools = [...this.tools, t];
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
					finishedAt: Date.now()
				}
			];
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
