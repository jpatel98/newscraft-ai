// Minimal SSE parser for fetch-based streams. We can't use EventSource
// because it can't POST and can't send headers.

export interface SSEEvent {
	event: string;
	data: string;
}

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let idx: number;
			while ((idx = buf.indexOf('\n\n')) >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let event = 'message';
				const dataLines: string[] = [];
				for (const line of frame.split('\n')) {
					if (line.startsWith('event:')) event = line.slice(6).trim();
					else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
				}
				const data = dataLines.join('\n');
				if (data) yield { event, data };
			}
		}
	} finally {
		reader.releaseLock();
	}
}
