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
	claimPartialAssistantMessage,
	createConversation,
	deleteMessagesFrom,
	finalizeMessage,
	getConversation,
	getMessageById,
	getMessages,
	lastAssistantMessage,
	parseContent,
	releasePartialAssistantMessageClaim,
	setMessageToolCalls
} from '$lib/server/db/conversations';
import { generateConversationTitle } from '$lib/server/conversation-title';
import { contentText, type ChatCommand, type ContentPart, type AgentCommand, type MessageContent } from '$lib/types';
import { readSSE } from '$lib/utils/sse-client';
import { parseSlashCommand, type SlashParseResult } from '$lib/utils/slash';
import { StreamEventState, sseFrame, type PersistedSource, type StreamToolCall } from '$lib/utils/stream-events';
import {
	mergeToolMetadata,
	citationNumbersInText,
	parseToolMetadata,
	resolvedCitationNumbersForAnswer,
	serializeAnswerProvenance,
	serializeToolMetadata,
	sourceContextForFollowup
} from '$lib/utils/tool-metadata';
import {
	getConversationReasoningEffort,
	parseReasoningEffort,
	reasoningEffortLabel,
	setConversationReasoningEffort
} from '$lib/server/reasoning';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import { checkRateLimit } from '$lib/server/rate-limit';
import { saveMessageProvenance } from '$lib/server/db/message-provenance';
import { newId } from '$lib/utils/id';
import type { CitationRecord, DocumentContext, NewsroomContext } from '@newscraft/shared';
import { getNewsroomProfile } from '$lib/server/documents/profiles';
import { getConversationDocumentService } from '$lib/server/documents/runtime';
import type { ConversationDocumentService } from '$lib/server/documents/service';

interface Body {
	conversation_id?: string;
	content?: MessageContent;
	regenerate?: boolean;
	resume?: boolean;
	message_id?: string;
	command?: ChatCommand;
	trace_id?: string;
	document_ids?: string[];
	output_action?: 'producer_brief' | 'thirty_second_script' | 'interview_questions' | 'copy_with_citations';
	source_message_id?: string;
}

// Agent caps the request body around 1 MB; keep some headroom for the
// surrounding JSON envelope, system prompt, and prior turns.
const MAX_REQUEST_BYTES = 950 * 1024;
const TRACE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const OUTPUT_ACTION_PROMPTS: Record<NonNullable<Body['output_action']>, string> = {
	producer_brief:
		'Turn the previous answer into a concise producer brief. Preserve confirmed facts, uncertainty, and every citation marker. Do not search for new information.',
	thirty_second_script:
		`Using only the previous answer, write a broadcast television OC/VO package for a 25-to-30-second anchor read.

Use this exact structure:

**ON CAM**
[One strong opening sentence that immediately establishes what happened and, when known, where and when.]

**VO**
[Two to four short sentences with the essential details, attribution, impact, and confirmed next step.]

**BANNER**
[A simple 5-to-7-word lower-third, aiming for 45-to-55 characters.]

Write the script copy and banner in uppercase. Keep the ON CAM and VO to 3-to-5 concise sentences total and about 55-to-75 spoken words. Use short, direct, conversational broadcast language in the present or immediate past tense. Write numbers, times, and acronyms for a natural anchor read without changing their meaning. Lead with immediate context, briefly expand the key facts, and end with the consequence, impact, or next step only when the source answer supports one. Preserve attribution, uncertainty, and every relevant citation marker. Keep citation markers attached to the claims they support; they do not count toward the spoken word target. Do not add facts, speculate, editorialize, use jargon, or search for new information. If a required detail is not confirmed in the source answer, omit it rather than inventing it.`,
	interview_questions:
		'Using only the previous answer, draft focused interview questions that probe the known facts, gaps, and disagreements. Keep relevant citation markers. Do not search for new information.',
	copy_with_citations:
		'Rewrite the previous answer as clean publication-ready copy with its existing citation markers intact. Do not add facts or search for new information.'
};
const OUTPUT_ACTION_VISIBLE_REQUESTS: Record<NonNullable<Body['output_action']>, string> = {
	producer_brief: 'Create a producer brief from this answer.',
	thirty_second_script: 'Write a 30-second OC/VO from this answer.',
	interview_questions: 'Draft interview questions from this answer.',
	copy_with_citations: 'Turn this answer into clean copy with citations.'
};

function sanitizeTraceId(value: string | undefined | null): string | null {
	const normalized = (value || '').trim();
	if (!TRACE_ID_RE.test(normalized)) return null;
	return normalized;
}

function resolveTraceId(request: Request, supplied?: string): string {
	return (
		sanitizeTraceId(supplied) ||
		sanitizeTraceId(request.headers.get('x-trace-id')) ||
		sanitizeTraceId(request.headers.get('x-request-id')) ||
		newId()
	);
}

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

function withFollowupSourceContext(content: AgentContent, toolCalls: string | null): AgentContent {
	const sourceContext = sourceContextForFollowup(toolCalls);
	if (!sourceContext) return content;
	if (typeof content === 'string') return `${content}\n\n${sourceContext}`;
	return [...content, { type: 'text', text: sourceContext }];
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

function withTraceDetails(details: Record<string, unknown>, traceId: string): Record<string, unknown> {
	return {
		...details,
		trace_id: traceId
	};
}

class NewsroomContextUnavailableError extends Error {
	constructor() {
		super('newsroom context unavailable');
		this.name = 'NewsroomContextUnavailableError';
	}
}

async function requestResearchContext(input: {
	conversationId: string;
	orgId: string | null;
	accountId: string;
	documentIds: string[];
	query: string;
	traceId: string;
}): Promise<{ newsroomContext: NewsroomContext; documents: DocumentContext[] }> {
	let newsroomContext: NewsroomContext = { timezone: 'America/Toronto' };
	if (input.orgId) {
		try {
			const profile = await getNewsroomProfile(input.orgId);
			if (profile) {
				newsroomContext = {
					timezone: profile.timezone,
					...(profile.homeMarket ? { homeMarket: profile.homeMarket } : {}),
					...(profile.preferredDomains.length
						? { preferredDomains: profile.preferredDomains }
						: {})
				};
			}
		} catch (cause) {
			recordChatDiagnostic(input.conversationId, 'chat.newsroom_context_error', {
				trace_id: input.traceId,
				errorName: cause instanceof Error ? cause.name : 'Error'
			});
			throw new NewsroomContextUnavailableError();
		}
	}
	if (!input.documentIds.length) return { newsroomContext, documents: [] };

	const service = getConversationDocumentService();
	let available: Awaited<ReturnType<typeof service.listDocuments>>;
	try {
		available = await service.listDocuments(input.accountId, input.conversationId);
	} catch {
		throw error(503, 'PDF research is unavailable right now.');
	}
	const requested = input.documentIds.map((id) => available.find((document) => document.id === id));
	if (requested.some((document) => !document)) throw error(404, 'PDF not found');
	if (requested.some((document) => document?.state !== 'ready')) {
		throw error(409, 'PDFs must finish processing before sending');
	}
	const pageCounts = new Map(
		requested.flatMap((document) =>
			document ? [[document.id, document.pageCount ?? 0] as const] : []
		)
	);
	let context: Awaited<ReturnType<typeof service.buildContext>>;
	try {
		context = await service.buildContext({
			accountId: input.accountId,
			conversationId: input.conversationId,
			documentIds: input.documentIds,
			query: input.query
		});
	} catch {
		throw error(503, 'PDF research is unavailable right now.');
	}
	if (!context.pages.length) throw error(409, 'PDFs must finish processing before sending');
	const grouped = new Map<string, DocumentContext>();
	for (const page of context.pages) {
		const existing = grouped.get(page.documentId);
		const next: DocumentContext = existing ?? {
			id: page.documentId,
			filename: page.filename,
			downloadUrl: `/api/conversations/${input.conversationId}/documents/${page.documentId}/download`,
			pageCount: pageCounts.get(page.documentId) || page.pageNumber,
			pages: []
		};
		next.pages.push({ pageNumber: page.pageNumber, text: page.text });
		grouped.set(page.documentId, next);
	}
	return { newsroomContext, documents: Array.from(grouped.values()) };
}

async function validateRequestedDocuments(
	accountId: string,
	conversationId: string,
	documentIds: string[]
): Promise<void> {
	let available: Awaited<ReturnType<ConversationDocumentService['listDocuments']>>;
	try {
		available = await getConversationDocumentService().listDocuments(accountId, conversationId);
	} catch {
		throw error(503, 'PDF research is unavailable right now.');
	}
	const requested = documentIds.map((id) => available.find((document) => document.id === id));
	if (requested.some((document) => !document)) throw error(404, 'PDF not found');
	if (requested.some((document) => document?.state !== 'ready')) {
		throw error(409, 'PDFs must finish processing before sending');
	}
}

async function persistAnswerProvenance(input: {
	conversationId: string;
	messageId: string;
	tools?: StreamToolCall[];
	sources?: PersistedSource[];
	citations?: CitationRecord[];
	answerText?: string;
	startedAt: number;
	endedAt?: number;
	assistantChars: number;
	done: boolean;
	finishStatus?: 'completed' | 'partial' | 'failed' | 'cancelled';
	events?: Record<string, number>;
	transport?: string;
	reasoningEffort?: string;
	model?: string;
	traceId?: string;
}): Promise<void> {
	try {
		const endedAt = input.endedAt ?? Date.now();
		await saveMessageProvenance({
			messageId: input.messageId,
			conversationId: input.conversationId,
			now: endedAt,
			provenanceJson: serializeAnswerProvenance({
				messageId: input.messageId,
				conversationId: input.conversationId,
				tools: input.tools ?? [],
				sources: input.sources ?? [],
				citations: input.citations ?? [],
				answerText: input.answerText,
				startedAt: input.startedAt,
				endedAt,
				assistantChars: input.assistantChars,
				done: input.done,
				finishStatus: input.finishStatus,
				events: input.events,
				transport: input.transport,
				reasoningEffort: input.reasoningEffort,
				model: input.model
			})
		});
	} catch (err) {
		recordChatDiagnostic(input.conversationId, 'chat.provenance_error', {
			messageId: input.messageId,
			errorName: err instanceof Error ? err.name : 'Error',
			...(input.traceId ? { trace_id: input.traceId } : {})
		});
	}
}

async function localAssistantResponse(convoId: string, text: string, traceId: string): Promise<Response> {
	const startedAt = Date.now();
	recordChatDiagnostic(convoId, 'chat.local_response', {
		responseChars: text.length,
		trace_id: traceId
	});
	const row = await addMessage({ conversationId: convoId, role: 'assistant', content: text });
	await persistAnswerProvenance({
		conversationId: convoId,
		messageId: row.id,
		startedAt,
		assistantChars: text.length,
		answerText: text,
		done: true,
		finishStatus: 'completed',
		transport: 'local',
		traceId
	});
	return localTextStream(convoId, text, traceId);
}

function localTextStream(convoId: string, text: string, traceId: string): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				enc.encode(
					`event: agent.meta\ndata: ${JSON.stringify({
						conversation_id: convoId,
						trace_id: traceId
					})}\n\n`
				)
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

function gatewayUnavailableMessage(_detail: string): string {
	return [
		"I couldn't reach the research service, so I couldn't answer.",
		'Your message was saved. Try regenerate or send again once the service is healthy.'
	]
		.filter(Boolean)
		.join('\n\n');
}

function gatewayFailureKind(detail: string): string {
	if (/\b(?:400|401|403|404|405|409|422|429|500|502|503|504)\b/.test(detail)) {
		return 'http';
	}
	if (/abort|timeout/i.test(detail)) return 'timeout';
	if (/fetch|network|connect|dns|socket/i.test(detail)) return 'network';
	return 'unavailable';
}

async function localGatewayFailureResponse(
	convoId: string,
	detail: string,
	resumeMessageId: string | null | undefined,
	traceId: string
): Promise<Response> {
	const startedAt = Date.now();
	recordChatDiagnostic(
		convoId,
		'chat.gateway_failure',
		withTraceDetails(
			{
				resume: Boolean(resumeMessageId),
				failureKind: gatewayFailureKind(detail)
			},
			traceId
		)
	);
	const text = gatewayUnavailableMessage(detail);
	if (resumeMessageId) {
		await appendMessageContent(resumeMessageId, `\n\n${text}`);
		await finalizeMessage(resumeMessageId);
		const row = await getMessageById(resumeMessageId);
		const metadata = parseToolMetadata(row?.toolCalls);
		await persistAnswerProvenance({
			conversationId: convoId,
			messageId: resumeMessageId,
			tools: metadata.tools,
			sources: metadata.sources,
			citations: metadata.citations,
			startedAt,
			assistantChars: row ? contentText(parseContent(row.content)).length : text.length,
			answerText: row ? contentText(parseContent(row.content)) : text,
			done: true,
			finishStatus: 'failed',
			transport: 'local_gateway_failure',
			traceId
		});
		return localTextStream(convoId, `\n\n${text}`, traceId);
	}
	return localAssistantResponse(convoId, text, traceId);
}

function findCommand(commands: AgentCommand[], parsed: SlashParseResult): AgentCommand | undefined {
	return commands.find((cmd) => cmd.slash.toLowerCase() === parsed.slash);
}

function modelFromSseData(data: string): string | undefined {
	if (!data || data === '[DONE]') return undefined;
	try {
		const parsed = JSON.parse(data) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
		const value = (parsed as Record<string, unknown>).model;
		return typeof value === 'string' && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
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
	if (command.slash === '/feedback') {
		return 'Use `/feedback` in the chat composer to open the feedback capture form for this thread.';
	}
	return 'This command is not available from the web UI yet.';
}

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const clientAddress = getClientAddress();
	const rate = checkRateLimit(`chat:${locals.user.id}:${clientAddress}`, {
		limit: 60,
		windowMs: 10 * 60 * 1000
	});
	if (!rate.allowed) throw error(429, `too many chat requests; try again in ${Math.ceil(rate.retryAfterMs / 1000)}s`);

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
	const traceId = resolveTraceId(request, body.trace_id || locals.traceId);

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
	const documentIds = Array.isArray(body.document_ids)
		? Array.from(
				new Set(
					body.document_ids.filter(
						(value): value is string => typeof value === 'string' && value.trim().length > 0
					)
				)
			)
		: [];
	if (Array.isArray(body.document_ids) && body.document_ids.length > 3) {
		throw error(400, 'attach no more than three PDFs');
	}
	if (documentIds.length > 3) throw error(400, 'attach no more than three PDFs');
	if (documentIds.length) {
		await validateRequestedDocuments(accountId, convoId, documentIds);
	}
	const requestStartedAt = Date.now();
	recordChatDiagnostic(convoId, 'chat.request', {
		trace_id: traceId,
		contentLength: len,
		resume: isResume,
		regenerate: body.regenerate === true,
		newConversation: isNew
	});

	const isRegenerate = body.regenerate === true;
	let resumeMessageId: string | null = null;
	let outputActionSource:
		| Awaited<ReturnType<typeof getMessageById>>
		| undefined;
	let outputActionUpstreamContent: string | undefined;
	if (body.output_action) {
		if (!OUTPUT_ACTION_PROMPTS[body.output_action]) throw error(400, 'invalid output action');
		if (!body.source_message_id) throw error(400, 'source answer required');
		outputActionSource = await getMessageById(body.source_message_id);
		if (
			!outputActionSource ||
			outputActionSource.conversationId !== convoId ||
			outputActionSource.role !== 'assistant' ||
			outputActionSource.partial === 1
		) {
			throw error(404, 'source answer not found');
		}
		outputActionUpstreamContent = `${OUTPUT_ACTION_PROMPTS[body.output_action]}\n\nAnswer to transform:\n\n${contentText(
			parseContent(outputActionSource.content)
		)}`;
		if (isResume) body = { ...body, content: outputActionUpstreamContent };
	}

	if (isResume) {
		const messageId = body.message_id;
		if (!messageId) throw error(400, 'message_id required for resume');
		const target = await getMessageById(messageId);
		if (!target || target.conversationId !== convoId) throw error(404, 'message not found');
		if (target.role !== 'assistant') throw error(400, 'can only resume assistant messages');
		if (target.partial !== 1) throw error(400, 'message is not partial');
		if (!(await claimPartialAssistantMessage(messageId, convoId))) throw error(409, 'already resuming');
		resumeMessageId = messageId;
	} else if (isRegenerate) {
		const lastA = await lastAssistantMessage(convoId);
		if (lastA) await deleteMessagesFrom(convoId, lastA.id);
	} else {
		const outputActionPrompt = body.output_action ? OUTPUT_ACTION_PROMPTS[body.output_action] : undefined;
		const requestedContent = body.output_action
			? OUTPUT_ACTION_VISIBLE_REQUESTS[body.output_action]
			: body.content;
		const cleaned = sanitizeContent(requestedContent);
		if (cleaned == null) throw error(400, 'content required');
		if (typeof cleaned === 'string' && !cleaned.trim()) throw error(400, 'content required');
		let upstreamContent: MessageContent = outputActionUpstreamContent ?? cleaned;
		await addMessage({ conversationId: convoId, role: 'user', content: cleaned });
		if (body.output_action) {
			recordChatDiagnostic(convoId, 'chat.output_action', {
				trace_id: traceId,
				action: body.output_action
			});
		}

		if (typeof cleaned === 'string') {
			const parsed = parseSlashCommand(cleaned);
			if (parsed) {
				const commands = await listAgentCommands();
				const command = findCommand(commands, parsed);
				recordChatDiagnostic(convoId, 'chat.command', {
					trace_id: traceId,
					slash: parsed.slash,
					recognized: Boolean(command),
					kind: command?.kind ?? null,
					enabled: command?.enabled ?? null
				});
				if (!command) {
					return localAssistantResponse(
						convoId,
						`I don't recognize ${parsed.slash}. Use /commands to browse available commands, or remove the slash to send it as normal text.`,
						traceId
					);
				}
				if (command.kind === 'builtin') {
					return localAssistantResponse(
						convoId,
						await builtinResponse(command, commands, parsed.args, convoId),
						traceId
					);
				}
				if (!command.enabled) {
					return localAssistantResponse(
						convoId,
						command.blockedReason || 'This command is not available from the web UI yet.',
						traceId
					);
				}
				const expanded = await expandAgentSkill(command.slash, parsed.args, convoId);
				if (!expanded.trim()) {
					return localAssistantResponse(
						convoId,
						`I found ${command.slash}, but it did not produce a usable skill prompt.`,
						traceId
					);
				}
				upstreamContent = expanded;
			}
		}

		if (upstreamContent !== cleaned || outputActionPrompt) {
			body = { ...body, content: upstreamContent };
		}
	}

	const reasoningEffort = await getConversationReasoningEffort(convoId);
	const messages = await getMessages(convoId);
	const inheritedMetadata = body.output_action
		? parseToolMetadata(outputActionSource?.toolCalls)
		: null;
	recordChatDiagnostic(convoId, 'chat.history_built', {
		trace_id: traceId,
		messageCount: messages.length,
		reasoningEffort
	});
	const history = messages.map<AgentMessage>((m) => {
		const parsed = parseContent(m.content);
		let content = toAgentContent(parsed);
		if (m.role === 'assistant') content = withFollowupSourceContext(content, m.toolCalls);
		return {
			role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
			content
		};
	});
	if ((!isResume && !isRegenerate && body.content) || (isResume && body.output_action && body.content)) {
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

	let researchContext: Awaited<ReturnType<typeof requestResearchContext>>;
	try {
		researchContext = await requestResearchContext({
			conversationId: convoId,
			orgId: convo.orgId,
			accountId,
			documentIds,
			query: body.content ? contentText(body.content) : '',
			traceId
		});
	} catch (cause) {
		if (cause instanceof NewsroomContextUnavailableError) {
			return localAssistantResponse(
				convoId,
				"I couldn't load your newsroom timezone, so I stopped before interpreting relative dates. Try again in a moment.",
				traceId
			);
		}
		throw cause;
	}

	const upstreamAbort = new AbortController();
	if (request.signal.aborted) upstreamAbort.abort();
	else request.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });

	const sessionId = deriveSessionId(history, `${accountId}:${convoId}`);
	let upstream: Response;
	let transport = 'chat_completions';
	try {
		// Prefer chat completions for the live app: Agent emits rich
		// agent.tool.progress/source events there, which power the visible
		// browser/search/tool activity strip. Keep Responses as a fallback for
		// gateways that only expose the newer endpoint shape.
		upstream = await streamChatCompletion(
			{
				messages: history,
				stream: true,
				reasoning_effort: reasoningEffort,
				newsroom_context: researchContext.newsroomContext,
				documents: researchContext.documents
			},
			{ signal: upstreamAbort.signal, sessionId, traceId }
		);
		transport = 'chat_completions';
		recordChatDiagnostic(convoId, 'chat.upstream_response', {
			trace_id: traceId,
			transport: 'chat_completions',
			status: upstream.status,
			ok: upstream.ok
		});
		if (!isResume && !upstream.ok && [400, 404, 405].includes(upstream.status)) {
			await upstream.text().catch(() => '');
			upstream = await streamResponse(
				{
					...responseInputFromHistory(history),
					stream: true,
					store: false,
					reasoning_effort: reasoningEffort,
					newsroom_context: researchContext.newsroomContext,
					documents: researchContext.documents
				},
				{ signal: upstreamAbort.signal, sessionId, traceId }
			);
			transport = 'responses';
			recordChatDiagnostic(convoId, 'chat.upstream_response', {
				trace_id: traceId,
				transport: 'responses',
				status: upstream.status,
				ok: upstream.ok
			});
		}
	} catch (err) {
		return await localGatewayFailureResponse(
			convoId,
			err instanceof Error ? err.message : String(err),
			resumeMessageId,
			traceId
		);
	}

	if (!upstream.ok || !upstream.body) {
		const text = await upstream.text().catch(() => '');
		return await localGatewayFailureResponse(
			convoId,
			`Agent ${upstream.status || 502}: ${text || upstream.statusText}`,
			resumeMessageId,
			traceId
		);
	}
	const upstreamBody = upstream.body;

	let assistantBuf = '';
	let done = false;
	let persisted = false;
	let sentDone = false;
	const streamState = new StreamEventState();
	const streamStats: Record<string, number> = {};
	let upstreamModel: string | undefined;

	async function persistAssistant(finishStatus?: 'completed' | 'partial' | 'failed' | 'cancelled') {
		if (persisted) return undefined;
		persisted = true;
		const capturedToolCalls = streamState.toolCalls();
		const captured = mergeToolMetadata(
			inheritedMetadata
				? serializeToolMetadata([], inheritedMetadata.sources, inheritedMetadata.citations)
				: null,
			capturedToolCalls,
			streamState.sourceList(),
			streamState.citationList()
		);
		const capturedSources = captured.sources;
		const capturedCitations = captured.citations;
		if (resumeMessageId) {
			const existingRow = await getMessageById(resumeMessageId);
			const merged = mergeToolMetadata(
				existingRow?.toolCalls ?? null,
				capturedToolCalls,
				capturedSources,
				capturedCitations
			);
			const provenanceTools = merged.tools;
			const provenanceSources = merged.sources;
			const provenanceCitations = merged.citations;
			if (assistantBuf) await appendMessageContent(resumeMessageId, assistantBuf);
			if (capturedToolCalls.length || capturedSources.length || capturedCitations.length) {
				await setMessageToolCalls(
					resumeMessageId,
					serializeToolMetadata(merged.tools, merged.sources, merged.citations)
				);
			}
			if (done) await finalizeMessage(resumeMessageId);
			else await releasePartialAssistantMessageClaim(resumeMessageId);
			const row = await getMessageById(resumeMessageId);
			if (row) {
				await persistAnswerProvenance({
					conversationId: convoId,
					messageId: row.id,
					tools: provenanceTools,
					sources: provenanceSources,
					citations: provenanceCitations,
					startedAt: requestStartedAt,
					assistantChars: contentText(parseContent(row.content)).length,
					answerText: contentText(parseContent(row.content)),
					done,
					finishStatus,
						events: streamStats,
						transport,
						reasoningEffort,
						model: upstreamModel,
						traceId
					});
				}
				return row;
			}
		if (!assistantBuf && capturedToolCalls.length === 0 && capturedCitations.length === 0) return undefined;
		const row = await addMessage({
			conversationId: convoId,
			role: 'assistant',
			content: assistantBuf,
			partial: !done,
			toolCalls: serializeToolMetadata(capturedToolCalls, capturedSources, capturedCitations)
		});
		await persistAnswerProvenance({
			conversationId: convoId,
			messageId: row.id,
			tools: capturedToolCalls,
			sources: capturedSources,
			citations: capturedCitations,
			startedAt: requestStartedAt,
			assistantChars: assistantBuf.length,
			answerText: assistantBuf,
			done,
			finishStatus,
			events: streamStats,
			transport,
			reasoningEffort,
			model: upstreamModel,
			traceId
		});
		return row;
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(
				enc.encode(
					`event: agent.meta\ndata: ${JSON.stringify({
						conversation_id: convoId,
						trace_id: traceId
					})}\n\n`
				)
			);

			try {
				for await (const ev of readSSE(upstreamBody)) {
					streamStats[ev.event || 'message'] = (streamStats[ev.event || 'message'] ?? 0) + 1;
					upstreamModel ??= modelFromSseData(ev.data);
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
				recordChatDiagnostic(convoId, 'chat.stream_error', {
					trace_id: traceId,
					errorName: e instanceof Error ? e.name : 'Error',
					elapsedMs: Date.now() - requestStartedAt,
					assistantChars: assistantBuf.length,
					events: streamStats
				});
				await persistAssistant('failed');
				controller.error(e);
				return;
			}

			const assistantRow = await persistAssistant(done ? 'completed' : 'partial');
			const citationMarkers = citationNumbersInText(assistantBuf);
			const citationRecords = assistantRow
				? parseToolMetadata(assistantRow.toolCalls).citations
				: streamState.citationList();
			const resolvedCitationCount = resolvedCitationNumbersForAnswer(
				assistantBuf,
				citationRecords
			).length;

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
				recordChatDiagnostic(convoId, 'chat.title_error', {
					trace_id: traceId,
					errorName: err instanceof Error ? err.name : 'Error'
				});
				console.warn('NewsCraft title generation failed', err);
			}

			recordChatDiagnostic(convoId, 'chat.stream_complete', {
				trace_id: traceId,
				elapsedMs: Date.now() - requestStartedAt,
				assistantChars: assistantBuf.length,
				done,
				persisted: Boolean(assistantRow),
				toolCount: streamState.toolCalls().length,
				sourceCount: streamState.sourceList().length,
				citationCount: citationRecords.length,
				citationMarkerCount: citationMarkers.length,
				resolvedCitationCount,
				danglingCitationCount: Math.max(0, citationMarkers.length - resolvedCitationCount),
				primarySourceCount: citationRecords.filter((citation) =>
					['official', 'primary', 'user_document'].includes(citation.sourceType)
				).length,
				unknownDateCount: citationRecords.filter((citation) => !citation.publicationDate).length,
				events: streamStats
			});
			if (sentDone || done) controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
		},
		cancel() {
			recordChatDiagnostic(convoId, 'chat.stream_cancel', {
				trace_id: traceId,
				elapsedMs: Date.now() - requestStartedAt,
				assistantChars: assistantBuf.length
			});
			upstreamAbort.abort();
			void persistAssistant('cancelled');
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
