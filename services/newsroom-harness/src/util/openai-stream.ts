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

function responseErrorMessage(response: unknown): string {
	const error = (response as { error?: { message?: string } } | null)?.error;
	return typeof error?.message === 'string' ? error.message : '';
}
