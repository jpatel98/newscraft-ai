import { error, type RequestHandler } from '@sveltejs/kit';
import {
	streamChatCompletion,
	completion,
	type HermesMessage,
	type HermesContent,
	type HermesContentPart
} from '$lib/server/hermes/transport';
import {
	addMessage,
	appendMessageContent,
	createConversation,
	deleteMessagesFrom,
	finalizeMessage,
	getConversation,
	getMessageById,
	getMessages,
	lastAssistantMessage,
	parseContent,
	setConversationTitle
} from '$lib/server/db/conversations';
import type { ContentPart, MessageContent } from '$lib/types';

interface Body {
	conversation_id?: string;
	content?: MessageContent;
	regenerate?: boolean;
	resume?: boolean;
	message_id?: string;
}

// In-memory guard against rapid double-resume of the same partial row.
// Cleared on stream completion or cancellation.
const resumingIds = new Set<string>();

// Hermes caps the request body around 1 MB; keep some headroom for the
// surrounding JSON envelope, system prompt, and prior turns.
const MAX_REQUEST_BYTES = 950 * 1024;

function sanitizeContent(c: MessageContent | undefined): MessageContent | null {
	if (c == null) return null;
	if (typeof c === 'string') return c;
	if (!Array.isArray(c)) return null;
	const parts: ContentPart[] = [];
	for (const p of c) {
		if (!p || typeof p !== 'object') continue;
		if (p.type === 'text' && typeof p.text === 'string') {
			parts.push({ type: 'text', text: p.text });
		} else if (
			p.type === 'image_url' &&
			p.image_url &&
			typeof p.image_url.url === 'string'
		) {
			parts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
		}
		// anything else (notably `type:'file'`) is dropped — Hermes rejects it.
	}
	if (parts.length === 0) return null;
	const onlyText = parts.every((p) => p.type === 'text');
	if (onlyText) return parts.map((p) => (p as { text: string }).text).join('\n');
	return parts;
}

function toHermesContent(c: MessageContent): HermesContent {
	if (typeof c === 'string') return c;
	return c.map<HermesContentPart>((p) =>
		p.type === 'text'
			? { type: 'text', text: p.text }
			: { type: 'image_url', image_url: { url: p.image_url.url } }
	);
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

	const len = Number(request.headers.get('content-length') ?? '0');
	if (len > MAX_REQUEST_BYTES) {
		throw error(413, 'request too large — try fewer or smaller attachments');
	}

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	// --- Resolve conversation + decide what to stream ---
	const isResume = body.resume === true;
	let convo = body.conversation_id ? getConversation(body.conversation_id) : undefined;
	const isNew = !convo && !isResume;
	if (!convo) {
		if (isResume) throw error(404, 'conversation not found');
		convo = createConversation();
	}
	const convoId = convo.id;

	const isRegenerate = body.regenerate === true;
	let resumeMessageId: string | null = null;

	if (isResume) {
		const messageId = body.message_id;
		if (!messageId) throw error(400, 'message_id required for resume');
		const target = getMessageById(messageId);
		if (!target || target.conversationId !== convoId) throw error(404, 'message not found');
		if (target.role !== 'assistant') throw error(400, 'can only resume assistant messages');
		if (target.partial !== 1) throw error(400, 'message is not partial');
		if (resumingIds.has(messageId)) throw error(409, 'already resuming');
		resumingIds.add(messageId);
		resumeMessageId = messageId;
	} else if (isRegenerate) {
		const lastA = lastAssistantMessage(convoId);
		if (lastA) deleteMessagesFrom(convoId, lastA.id);
	} else {
		const cleaned = sanitizeContent(body.content);
		if (cleaned == null) throw error(400, 'content required');
		if (typeof cleaned === 'string' && !cleaned.trim()) throw error(400, 'content required');
		addMessage({ conversationId: convoId, role: 'user', content: cleaned });
	}

	const history = getMessages(convoId).map<HermesMessage>((m) => {
		const parsed = parseContent(m.content);
		return {
			role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
			content: toHermesContent(parsed)
		};
	});

	const upstream = await streamChatCompletion(
		{ messages: history, stream: true },
		{ signal: request.signal }
	);

	if (!upstream.ok || !upstream.body) {
		if (resumeMessageId) resumingIds.delete(resumeMessageId);
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
		if (resumeMessageId) {
			if (assistantBuf) appendMessageContent(resumeMessageId, assistantBuf);
			if (done) finalizeMessage(resumeMessageId);
			resumingIds.delete(resumeMessageId);
			return getMessageById(resumeMessageId);
		}
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
						.map<HermesMessage>((m) => {
							const parsed = parseContent(m.content);
							const text =
								typeof parsed === 'string'
									? parsed
									: parsed
											.filter((p) => p.type === 'text')
											.map((p) => (p as { text: string }).text)
											.join('\n');
							return { role: m.role as 'user' | 'assistant', content: text };
						});
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
