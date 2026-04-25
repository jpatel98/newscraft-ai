import { error, type RequestHandler } from '@sveltejs/kit';
import { streamChatCompletion, type HermesMessage } from '$lib/server/hermes/transport';
import {
	addMessage,
	createConversation,
	getConversation,
	getMessages
} from '$lib/server/db/conversations';

interface Body {
	conversation_id?: string;
	content: string;
}

interface OpenAIChunk {
	choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}
	const content = (body.content ?? '').trim();
	if (!content) throw error(400, 'content required');

	// Resolve or create conversation
	let convo = body.conversation_id ? getConversation(body.conversation_id) : undefined;
	if (!convo) convo = createConversation();
	const convoId = convo.id;

	// Persist user message before opening upstream so a crashed stream doesn't lose it
	addMessage({ conversationId: convoId, role: 'user', content });

	// Build prompt history from DB
	const history = getMessages(convoId).map<HermesMessage>((m) => ({
		role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
		content: m.content
	}));

	const upstream = await streamChatCompletion(
		{ messages: history, stream: true },
		{ signal: request.signal }
	);

	if (!upstream.ok || !upstream.body) {
		const text = await upstream.text().catch(() => '');
		throw error(upstream.status || 502, `gateway: ${text || upstream.statusText}`);
	}

	let assistantBuf = '';
	let buffered = '';
	let done = false;

	const reader = upstream.body.getReader();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			// Tell the client which conversation this stream belongs to
			controller.enqueue(
				enc.encode(`event: hermes.meta\ndata: ${JSON.stringify({ conversation_id: convoId })}\n\n`)
			);

			try {
				for (;;) {
					const { value, done: rDone } = await reader.read();
					if (rDone) break;
					if (!value) continue;

					controller.enqueue(value);

					// Parse SSE frames in-flight to accumulate assistant text
					buffered += dec.decode(value, { stream: true });
					let idx: number;
					while ((idx = buffered.indexOf('\n\n')) >= 0) {
						const frame = buffered.slice(0, idx);
						buffered = buffered.slice(idx + 2);
						let event = 'message';
						let dataLines: string[] = [];
						for (const line of frame.split('\n')) {
							if (line.startsWith('event:')) event = line.slice(6).trim();
							else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
						}
						const data = dataLines.join('\n');
						if (!data) continue;
						if (event !== 'message') continue; // skip hermes.tool.progress etc.
						if (data === '[DONE]') {
							done = true;
							continue;
						}
						try {
							const j = JSON.parse(data) as OpenAIChunk;
							const piece = j.choices?.[0]?.delta?.content ?? '';
							if (piece) assistantBuf += piece;
						} catch {
							/* keep streaming even if a chunk is malformed */
						}
					}
				}
			} catch (e) {
				// client aborted or upstream errored — persist whatever we have
				if (assistantBuf) {
					addMessage({
						conversationId: convoId,
						role: 'assistant',
						content: assistantBuf,
						partial: !done
					});
				}
				controller.error(e);
				return;
			}

			if (assistantBuf) {
				addMessage({
					conversationId: convoId,
					role: 'assistant',
					content: assistantBuf,
					partial: !done
				});
			}
			controller.close();
		},
		cancel() {
			reader.cancel().catch(() => {});
			if (assistantBuf) {
				addMessage({
					conversationId: convoId,
					role: 'assistant',
					content: assistantBuf,
					partial: !done
				});
			}
		}
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
