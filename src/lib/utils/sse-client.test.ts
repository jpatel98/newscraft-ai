import { describe, expect, it } from 'vitest';
import { readSSE, type SSEEvent } from './sse-client';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
			controller.close();
		}
	});
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
	const out: SSEEvent[] = [];
	for await (const event of readSSE(body)) out.push(event);
	return out;
}

describe('readSSE', () => {
	it('ignores comment heartbeat frames', async () => {
		const events = await collect(
			streamOf(': ping\n\n', 'id: 1\nevent: a\ndata: {"x":1}\n\n', ': ping\n\n', 'event: b\ndata: 2\n\n')
		);
		expect(events).toEqual([
			{ event: 'a', data: '{"x":1}', id: '1' },
			{ event: 'b', data: '2', id: undefined }
		]);
	});

	it('ignores a comment line inside a data frame', async () => {
		const events = await collect(streamOf(': keep-alive\nevent: a\ndata: ok\n\n'));
		expect(events).toEqual([{ event: 'a', data: 'ok', id: undefined }]);
	});
});
