import { error, type RequestHandler } from '@sveltejs/kit';
import {
	streamChatCompletion,
	streamResponse,
	deriveSessionId,
	gatewayHealth,
	type AgentMessage,
	type AgentContent,
	type AgentContentPart,
	type AgentResponseContentPart,
	type AgentResponseInputMessage
} from '$lib/server/agent/transport';
import { expandAgentSkill, listAgentCommands } from '$lib/server/agent/bridge';
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
	setMessageToolCalls
} from '$lib/server/db/conversations';
import { generateConversationTitle } from '$lib/server/conversation-title';
import { contentText, type ChatCommand, type ContentPart, type AgentCommand, type MessageContent } from '$lib/types';
import { readSSE } from '$lib/utils/sse-client';
import { parseSlashCommand, type SlashParseResult } from '$lib/utils/slash';
import { StreamEventState, sseFrame } from '$lib/utils/stream-events';
import { mergeToolMetadata, serializeToolMetadata } from '$lib/utils/tool-metadata';
import {
	getConversationReasoningEffort,
	parseReasoningEffort,
	reasoningEffortLabel,
	setConversationReasoningEffort
} from '$lib/server/reasoning';

interface Body {
	conversation_id?: string;
	content?: MessageContent;
	regenerate?: boolean;
	resume?: boolean;
	message_id?: string;
	command?: ChatCommand;
}

// In-memory guard against rapid double-resume of the same partial row.
// Cleared on stream completion or cancellation.
const resumingIds = new Set<string>();

// Agent caps the request body around 1 MB; keep some headroom for the
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
		// anything else (notably `type:'file'`) is dropped — Agent rejects it.
	}
	if (parts.length === 0) return null;
	const onlyText = parts.every((p) => p.type === 'text');
	if (onlyText) return parts.map((p) => (p as { text: string }).text).join('\n');
	return parts;
}

function toAgentContent(c: MessageContent): AgentContent {
	if (typeof c === 'string') return c;
	return c.map<AgentContentPart>((p) =>
		p.type === 'text'
			? { type: 'text', text: p.text }
			: { type: 'image_url', image_url: { url: p.image_url.url } }
	);
}

function toResponsesContent(c: AgentContent): string | AgentResponseContentPart[] {
	if (typeof c === 'string') return c;
	return c.map<AgentResponseContentPart>((p) =>
		p.type === 'text'
			? { type: 'input_text', text: p.text }
			: { type: 'input_image', image_url: p.image_url.url }
	);
}

type ResponseHistoryMessage = { role: 'user' | 'assistant'; content: AgentContent };

function responseInputFromHistory(history: AgentMessage[]): {
	instructions?: string;
	input: AgentResponseInputMessage[];
} {
	const instructions = history
		.filter((m) => m.role === 'system')
		.map((m) => (typeof m.content === 'string' ? m.content : contentText(m.content)))
		.join('\n\n')
		.trim();
	const input = history
		.filter((m): m is ResponseHistoryMessage => m.role === 'user' || m.role === 'assistant')
		.map<AgentResponseInputMessage>((m) => ({
			role: m.role,
			content: toResponsesContent(m.content)
		}));
	return { input, instructions: instructions || undefined };
}

const enc = new TextEncoder();

const FAST_SOURCE_SYSTEM =
	'For source-backed or current-events requests, prioritize speed. Use a fast source budget: search once, read at most 4 highly relevant sources, avoid duplicate domains unless necessary, stop as soon as the answer is sufficiently supported, and answer within about 30 seconds. If sources are incomplete, provide the best supported answer with clear caveats instead of continuing to search.';

const INTERACTIVE_WEB_SYSTEM =
	'You are running inside the NewsCraft web chat, where the user expects live visible progress. For ordinary requests, avoid delegate_task, subagents, and skill_view; do the work directly with available browser, search, file, and terminal tools so progress streams back step by step. Only delegate or inspect skills when the user explicitly asks for subagents, parallel agents, or a named skill. If a tool path is slow or inconclusive, give the best current answer with caveats instead of waiting indefinitely.';

function textFrame(text: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function appendSystemInstruction(history: AgentMessage[], instruction: string): void {
	const idx = history.findIndex((m) => m.role === 'system');
	if (idx >= 0) {
		const existing = history[idx].content;
		history[idx] = {
			role: 'system',
			content: `${typeof existing === 'string' ? existing : contentText(existing)}\n\n${instruction}`
		};
	} else {
		history.unshift({ role: 'system', content: instruction });
	}
}

async function localAssistantResponse(convoId: string, text: string): Promise<Response> {
	await addMessage({ conversationId: convoId, role: 'assistant', content: text });
	return localTextStream(convoId, text);
}

function localTextStream(convoId: string, text: string): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				enc.encode(`event: agent.meta\ndata: ${JSON.stringify({ conversation_id: convoId })}\n\n`)
			);
			controller.enqueue(enc.encode(textFrame(text)));
			controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
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
}

function gatewayUnavailableMessage(detail: string): string {
	const cleaned = detail.replace(/\s+/g, ' ').trim().slice(0, 240);
	return [
		"I couldn't reach the agent gateway, so I couldn't draft a reply.",
		'Your message was saved. Try regenerate or send again once the gateway is healthy.',
		cleaned ? `Gateway detail: ${cleaned}` : ''
	]
		.filter(Boolean)
		.join('\n\n');
}

async function localGatewayFailureResponse(convoId: string, detail: string, resumeMessageId?: string | null): Promise<Response> {
	const text = gatewayUnavailableMessage(detail);
	if (resumeMessageId) {
		await appendMessageContent(resumeMessageId, `\n\n${text}`);
		await finalizeMessage(resumeMessageId);
		resumingIds.delete(resumeMessageId);
		return localTextStream(convoId, `\n\n${text}`);
	}
	return localAssistantResponse(convoId, text);
}

function findCommand(commands: AgentCommand[], parsed: SlashParseResult): AgentCommand | undefined {
	return commands.find((cmd) => cmd.slash.toLowerCase() === parsed.slash);
}

function commandsHelp(commands: AgentCommand[]): string {
	const safeBuiltins = commands.filter((cmd) => cmd.kind === 'builtin' && cmd.enabled);
	const skills = commands.filter((cmd) => cmd.kind === 'skill' && cmd.enabled).slice(0, 32);
	const lines = ['Available web commands:', ''];
	for (const cmd of safeBuiltins) {
		lines.push(`- ${cmd.slash}${cmd.argsHint ? ` ${cmd.argsHint}` : ''}: ${cmd.description}`);
	}
	if (skills.length) {
		lines.push('', 'Installed skill commands:');
		for (const cmd of skills) lines.push(`- ${cmd.slash}: ${cmd.description}`);
		if (commands.filter((cmd) => cmd.kind === 'skill' && cmd.enabled).length > skills.length) {
			lines.push('', 'Open Settings -> Skills to browse the full list.');
		}
	}
	return lines.join('\n');
}

async function builtinResponse(
	command: AgentCommand,
	commands: AgentCommand[],
	args: string,
	convoId: string
): Promise<string> {
	if (!command.enabled) return command.blockedReason || 'This command is not available from the web UI yet.';
	if (command.slash === '/help' || command.slash === '/commands') return commandsHelp(commands);
	if (command.slash === '/reasoning') {
		const parsed = parseReasoningEffort(args);
		if (!parsed) {
			const current = await getConversationReasoningEffort(convoId);
			return [
				`Reasoning is currently set to ${reasoningEffortLabel(current)} for this thread.`,
				'Use `/reasoning low`, `/reasoning medium`, `/reasoning high`, or `/reasoning default`.'
			].join('\n\n');
		}
		const next = await setConversationReasoningEffort(convoId, parsed);
		return `Reasoning set to ${reasoningEffortLabel(next)} for this thread.`;
	}
	if (command.slash === '/status') {
		const health = await gatewayHealth();
		return health.ok
			? `Agent gateway is reachable. Status ${health.status}.`
			: `Agent gateway is not reachable right now. ${health.body}`;
	}
	if (command.slash === '/profile') {
		const skillCount = commands.filter((cmd) => cmd.kind === 'skill' && cmd.enabled).length;
		return `Profile: agent-gateway\nInstalled skills: ${skillCount}`;
	}
	return 'This command is not available from the web UI yet.';
}

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
	const accountId = locals.user.id;
	let convo = body.conversation_id ? await getConversation(accountId, body.conversation_id) : undefined;
	const isNew = !convo && !isResume;
	if (!convo) {
		if (isResume) throw error(404, 'conversation not found');
		convo = await createConversation(accountId);
	}
	const convoId = convo.id;

	const isRegenerate = body.regenerate === true;
	let resumeMessageId: string | null = null;

	if (isResume) {
		const messageId = body.message_id;
		if (!messageId) throw error(400, 'message_id required for resume');
		const target = await getMessageById(messageId);
		if (!target || target.conversationId !== convoId) throw error(404, 'message not found');
		if (target.role !== 'assistant') throw error(400, 'can only resume assistant messages');
		if (target.partial !== 1) throw error(400, 'message is not partial');
		if (resumingIds.has(messageId)) throw error(409, 'already resuming');
		resumingIds.add(messageId);
		resumeMessageId = messageId;
	} else if (isRegenerate) {
		const lastA = await lastAssistantMessage(convoId);
		if (lastA) await deleteMessagesFrom(convoId, lastA.id);
	} else {
		const cleaned = sanitizeContent(body.content);
		if (cleaned == null) throw error(400, 'content required');
		if (typeof cleaned === 'string' && !cleaned.trim()) throw error(400, 'content required');
		let upstreamContent = cleaned;
		await addMessage({ conversationId: convoId, role: 'user', content: cleaned });

		if (typeof cleaned === 'string') {
			const parsed = parseSlashCommand(cleaned);
			if (parsed) {
				const commands = await listAgentCommands();
				const command = findCommand(commands, parsed);
				if (!command) {
					return localAssistantResponse(
						convoId,
						`I don't recognize ${parsed.slash}. Use /commands to browse available commands, or remove the slash to send it as normal text.`
					);
				}
				if (command.kind === 'builtin') {
					return localAssistantResponse(
						convoId,
						await builtinResponse(command, commands, parsed.args, convoId)
					);
				}
				if (!command.enabled) {
					return localAssistantResponse(
						convoId,
						command.blockedReason || 'This command is not available from the web UI yet.'
					);
				}
				const expanded = await expandAgentSkill(command.slash, parsed.args, convoId);
				if (!expanded.trim()) {
					return localAssistantResponse(
						convoId,
						`I found ${command.slash}, but it did not produce a usable skill prompt.`
					);
				}
				upstreamContent = expanded;
			}
		}

		if (upstreamContent !== cleaned) {
			body = { ...body, content: upstreamContent };
		}
	}

	const messages = await getMessages(convoId);
	const history = messages.map<AgentMessage>((m) => {
		const parsed = parseContent(m.content);
		return {
			role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
			content: toAgentContent(parsed)
		};
	});
	if (!isResume && !isRegenerate && body.content) {
		const lastUser = [...history].reverse().find((m) => m.role === 'user');
		if (lastUser) lastUser.content = toAgentContent(body.content);
	}

	const override = convo.systemPrompt?.trim();
	if (override) {
		const idx = history.findIndex((m) => m.role === 'system');
		const sys: AgentMessage = { role: 'system', content: override };
		if (idx >= 0) history[idx] = sys;
		else history.unshift(sys);
	}
	appendSystemInstruction(history, INTERACTIVE_WEB_SYSTEM);
	appendSystemInstruction(history, FAST_SOURCE_SYSTEM);

	const upstreamAbort = new AbortController();
	if (request.signal.aborted) upstreamAbort.abort();
	else request.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });

	const reasoningEffort = await getConversationReasoningEffort(convoId);
	const sessionId = deriveSessionId(history);
	let upstream: Response;
	try {
		// Prefer chat completions for the live app: Agent emits rich
		// agent.tool.progress/source events there, which power the visible
		// browser/search/tool activity strip. Keep Responses as a fallback for
		// gateways that only expose the newer endpoint shape.
		upstream = await streamChatCompletion(
			{ messages: history, stream: true, reasoning_effort: reasoningEffort },
			{ signal: upstreamAbort.signal, sessionId }
		);
		if (!isResume && !upstream.ok && [400, 404, 405].includes(upstream.status)) {
			await upstream.text().catch(() => '');
			upstream = await streamResponse(
				{ ...responseInputFromHistory(history), stream: true, store: false, reasoning_effort: reasoningEffort },
				{ signal: upstreamAbort.signal, sessionId }
			);
		}
	} catch (err) {
		return await localGatewayFailureResponse(convoId, err instanceof Error ? err.message : String(err), resumeMessageId);
	}

	if (!upstream.ok || !upstream.body) {
		if (resumeMessageId) resumingIds.delete(resumeMessageId);
		const text = await upstream.text().catch(() => '');
		return await localGatewayFailureResponse(
			convoId,
			`Agent ${upstream.status || 502}: ${text || upstream.statusText}`,
			resumeMessageId
		);
	}
	const upstreamBody = upstream.body;

	let assistantBuf = '';
	let done = false;
	let persisted = false;
	let sentDone = false;
	const streamState = new StreamEventState();

	async function persistAssistant() {
		if (persisted) return undefined;
		persisted = true;
		const capturedToolCalls = streamState.toolCalls();
		const capturedSources = streamState.sourceList();
		if (resumeMessageId) {
			if (assistantBuf) await appendMessageContent(resumeMessageId, assistantBuf);
			if (capturedToolCalls.length || capturedSources.length) {
				const row = await getMessageById(resumeMessageId);
				const merged = mergeToolMetadata(row?.toolCalls ?? null, capturedToolCalls, capturedSources);
				await setMessageToolCalls(resumeMessageId, serializeToolMetadata(merged.tools, merged.sources));
			}
			if (done) await finalizeMessage(resumeMessageId);
			resumingIds.delete(resumeMessageId);
			return getMessageById(resumeMessageId);
		}
		if (!assistantBuf && capturedToolCalls.length === 0) return undefined;
		return await addMessage({
			conversationId: convoId,
			role: 'assistant',
			content: assistantBuf,
			partial: !done,
			toolCalls: serializeToolMetadata(capturedToolCalls, capturedSources)
		});
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(
				enc.encode(`event: agent.meta\ndata: ${JSON.stringify({ conversation_id: convoId })}\n\n`)
			);

			try {
				for await (const ev of readSSE(upstreamBody)) {
					for (const update of streamState.apply(ev.event, ev.data)) {
						if (update.delta) assistantBuf += update.delta;
						if (update.done) done = true;
						if (update.failed) throw new Error(update.failed);
					}
					if (ev.data === '[DONE]') {
						sentDone = true;
						continue;
					}
					controller.enqueue(enc.encode(sseFrame(ev.event, ev.data)));
				}
			} catch (e) {
				await persistAssistant();
				controller.error(e);
				return;
			}

			const assistantRow = await persistAssistant();

			// Title auto-summarization: first turn only, fire-and-await briefly so
			// the client gets the title before the stream closes (and before its
			// invalidateAll() picks up the conversation list).
			try {
				if (assistantRow) {
					const result = await generateConversationTitle(accountId, convoId, {
						force: isNew,
						idempotencyKey: `title-${convoId}-${assistantRow.id}`
					});
					if (result?.generated && result.title) {
						controller.enqueue(
							enc.encode(`event: agent.title\ndata: ${JSON.stringify({ title: result.title })}\n\n`)
						);
					}
				}
			} catch (err) {
				console.warn('NewsCraft title generation failed', err);
			}

			if (sentDone || done) controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
		},
		cancel() {
			upstreamAbort.abort();
			void persistAssistant();
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
