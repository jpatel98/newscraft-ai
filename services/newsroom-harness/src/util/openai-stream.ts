export interface OpenAiResponseStreamResult {
	/** The full response object from the terminal stream event, if one arrived. */
	response: unknown;
	status: 'completed' | 'incomplete' | 'failed' | 'interrupted';
	error?: string;
}

/**
 * Read an OpenAI Responses API SSE stream, forwarding output-text deltas as
 * they arrive and returning the terminal response object (which has the same
 * shape as a non-streaming response, including output items and usage).
 */
export async function readOpenAiResponseStream(
	body: ReadableStream<Uint8Array>,
	onTextDelta: (delta: string) => void
): Promise<OpenAiResponseStreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const result: OpenAiResponseStreamResult = { response: null, status: 'interrupted' };
	let buffer = '';

	const handleFrame = (frame: string) => {
		const payload = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n');
		if (!payload || payload === '[DONE]') return;
		let event: {
			type?: string;
			delta?: unknown;
			response?: unknown;
			error?: { message?: string };
			message?: string;
		};
		try {
			event = JSON.parse(payload);
		} catch {
			return;
		}
		if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
			onTextDelta(event.delta);
			return;
		}
		if (event.type === 'response.completed' && event.response) {
			result.response = event.response;
			result.status = 'completed';
			return;
		}
		if (event.type === 'response.incomplete' && event.response) {
			result.response = event.response;
			result.status = 'incomplete';
			return;
		}
		if (event.type === 'response.failed') {
			result.response = event.response ?? result.response;
			result.status = 'failed';
			result.error = responseErrorMessage(event.response) || 'response failed';
			return;
		}
		if (event.type === 'error') {
			result.status = 'failed';
			result.error = event.error?.message || event.message || 'stream error';
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let separator: number;
			while ((separator = buffer.indexOf('\n\n')) >= 0) {
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				handleFrame(frame);
			}
		}
		if (buffer.trim()) handleFrame(buffer);
	} finally {
		reader.releaseLock();
	}
	return result;
}

export interface ChatCompletionStreamResult {
	/** Synthetic terminal response built from streamed chat-completion chunks. */
	response: unknown;
	status: 'completed' | 'failed' | 'interrupted';
	error?: string;
}

/**
 * Read Chat Completions/Sonar SSE streams, forwarding content deltas and
 * returning a response-like object with accumulated text plus provider metadata.
 */
export async function readChatCompletionStream(
	body: ReadableStream<Uint8Array>,
	onTextDelta: (delta: string) => void
): Promise<ChatCompletionStreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const result: ChatCompletionStreamResult = { response: null, status: 'interrupted' };
	let buffer = '';
	let output = '';
	let searchResults: unknown;
	let citations: unknown;
	let usage: unknown;

	const terminalResponse = () => ({
		choices: [{ message: { role: 'assistant', content: output } }],
		...(Array.isArray(searchResults) ? { search_results: searchResults } : {}),
		...(Array.isArray(citations) ? { citations } : {}),
		...(usage && typeof usage === 'object' ? { usage } : {})
	});

	const handleFrame = (frame: string) => {
		const payload = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n');
		if (!payload) return;
		if (payload === '[DONE]') {
			result.status = 'completed';
			result.response = terminalResponse();
			return;
		}
		let event: {
			choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: string | null }>;
			error?: { message?: string };
			message?: string;
			search_results?: unknown;
			citations?: unknown;
			usage?: unknown;
		};
		try {
			event = JSON.parse(payload);
		} catch {
			return;
		}
		if (Array.isArray(event.search_results)) searchResults = event.search_results;
		if (Array.isArray(event.citations)) citations = event.citations;
		if (event.usage && typeof event.usage === 'object') usage = event.usage;
		if (event.error || event.message) {
			result.status = 'failed';
			result.error = event.error?.message || event.message || 'stream error';
			result.response = terminalResponse();
			return;
		}
		for (const choice of event.choices || []) {
			const delta = chatContentText(choice.delta?.content);
			if (delta) {
				output += delta;
				onTextDelta(delta);
			}
			const message = chatContentText(choice.message?.content);
			if (!output && message) output = message;
			if (choice.finish_reason) {
				result.status = 'completed';
				result.response = terminalResponse();
			}
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let separator: number;
			while ((separator = buffer.indexOf('\n\n')) >= 0) {
				const frame = buffer.slice(0, separator);
				buffer = buffer.slice(separator + 2);
				handleFrame(frame);
			}
		}
		if (buffer.trim()) handleFrame(buffer);
	} finally {
		reader.releaseLock();
	}
	if (output && result.status === 'interrupted') {
		result.response = terminalResponse();
	}
	return result;
}

function responseErrorMessage(response: unknown): string {
	const error = (response as { error?: { message?: string } } | null)?.error;
	return typeof error?.message === 'string' ? error.message : '';
}

function chatContentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (!part || typeof part !== 'object') return '';
			const record = part as { type?: string; text?: string };
			return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
		})
		.filter(Boolean)
		.join('\n');
}
