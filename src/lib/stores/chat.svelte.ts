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

class ChatSession {
	abort = $state<AbortController | null>(null);
	tools = $state<ToolProgress[]>([]);
	streaming = $state(false);
	editRequest = $state<string | null>(null); // populated by ↑; consumed by Composer
	lastUserContent = $state<string | null>(null); // set by the active conversation page; read by ↑ handler

	startStream(): AbortController {
		const c = new AbortController();
		this.abort = c;
		this.streaming = true;
		this.tools = [];
		return c;
	}

	endStream() {
		this.abort = null;
		this.streaming = false;
		this.tools = [];
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
		this.tools = this.tools.filter((t) => t.id !== id);
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
