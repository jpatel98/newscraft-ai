import { error, type RequestHandler } from '@sveltejs/kit';
import {
	streamChatCompletion,
	completion,
	type HermesMessage
} from '$lib/server/hermes/transport';
import {
	addMessage,
	createConversation,
	deleteMessagesFrom,
	getConversation,
	getMessages,
	lastAssistantMessage,
	setConversationTitle
} from '$lib/server/db/conversations';

interface Body {
	conversation_id?: string;
	content?: string;
	regenerate?: boolean;
}

interface OpenAIChunk {
	choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}
interface OpenAINonStream {
	choices?: Array<{ message?: { content?: string } }>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const TITLE_SYSTEM =
	'You generate a 4-to-8-word, sentence-case title for a conversation. ' +
	'Reply with ONLY the title text — no quotes, no markdown, no trailing punctuation.';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	// --- Resolve conversation + decide what to stream ---
	let convo = body.conversation_id ? getConversation(body.conversation_id) : undefined;
	const isNew = !convo;
	if (!convo) convo = createConversation();
	const convoId = convo.id;

	const isRegenerate = body.regenerate === true;
	if (isRegenerate) {
		const lastA = lastAssistantMessage(convoId);
		if (lastA) deleteMessagesFrom(convoId, lastA.id);
	} else {
		const content = (body.content ?? '').trim();
		if (!content) throw error(400, 'content required');
		addMessage({ conversationId: convoId, role: 'user', content });
	}

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
	let persisted = false;
	const reader = upstream.body.getReader();

	function persistAssistant() {
		if (persisted) return undefined;
		persisted = true;
		if (!assistantBuf) return undefined;
		return addMessage({
			conversationId: convoId,
			role: 'assistant',
			content: assistantBuf,
			partial: !done
		});
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(
				enc.encode(`event: hermes.meta\ndata: ${JSON.stringify({ conversation_id: convoId })}\n\n`)
			);

			try {
				for (;;) {
					const { value, done: rDone } = await reader.read();
					if (rDone) break;
					if (!value) continue;

					controller.enqueue(value);

					buffered += dec.decode(value, { stream: true });
					let idx: number;
					while ((idx = buffered.indexOf('\n\n')) >= 0) {
						const frame = buffered.slice(0, idx);
						buffered = buffered.slice(idx + 2);
						let event = 'message';
						const dataLines: string[] = [];
						for (const line of frame.split('\n')) {
							if (line.startsWith('event:')) event = line.slice(6).trim();
							else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
						}
						const data = dataLines.join('\n');
						if (!data) continue;
						if (event !== 'message') continue;
						if (data === '[DONE]') {
							done = true;
							continue;
						}
						try {
							const j = JSON.parse(data) as OpenAIChunk;
							const piece = j.choices?.[0]?.delta?.content ?? '';
							if (piece) assistantBuf += piece;
						} catch {
							/* ignore malformed chunk */
						}
					}
				}
			} catch (e) {
				persistAssistant();
				controller.error(e);
				return;
			}

			const assistantRow = persistAssistant();

			// Title auto-summarization: first turn only, fire-and-await briefly so
			// the client gets the title before the stream closes (and before its
			// invalidateAll() picks up the conversation list).
			try {
				const fresh = getConversation(convoId);
				if (fresh && (isNew || !fresh.title) && assistantRow) {
					const seedHistory = getMessages(convoId)
						.filter((m) => m.role === 'user' || m.role === 'assistant')
						.slice(0, 4)
						.map<HermesMessage>((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
					const titleMessages: HermesMessage[] = [
						{ role: 'system', content: TITLE_SYSTEM },
						...seedHistory,
						{ role: 'user', content: 'Title for this conversation:' }
					];
					const idem = `title-${convoId}-${assistantRow.id}`;
					const result = (await completion(
						{ messages: titleMessages, stream: false, max_tokens: 24 },
						{ idempotencyKey: idem }
					)) as OpenAINonStream;
					const raw = result.choices?.[0]?.message?.content ?? '';
					const title = raw.trim().replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').slice(0, 80);
					if (title) {
						setConversationTitle(convoId, title);
						controller.enqueue(
							enc.encode(`event: hermes.title\ndata: ${JSON.stringify({ title })}\n\n`)
						);
					}
				}
			} catch {
				/* title generation is best-effort; never fails the stream */
			}

			controller.close();
		},
		cancel() {
			reader.cancel().catch(() => {});
			persistAssistant();
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
