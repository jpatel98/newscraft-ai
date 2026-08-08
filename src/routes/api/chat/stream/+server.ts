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
	claimPartialAssistantMessage,
	createConversation,
	deleteMessagesFrom,
	finalizeResumedAssistantMessage,
	getConversation,
	getMessageById,
	getMessages,
	parseContent,
} from '$lib/server/db/conversations';
import { generateConversationTitle } from '$lib/server/conversation-title';
import { contentText, type ChatCommand, type ContentPart, type AgentCommand, type MessageContent } from '$lib/types';
import { readSSE } from '$lib/utils/sse-client';
import { parseSlashCommand, type SlashParseResult } from '$lib/utils/slash';
import {
	sanitizeCitationEventData,
	sanitizeUnresolvedCitationMarkers,
	StreamingCitationSanitizer,
	StreamEventState,
	sseFrame,
	type PersistedSource,
	type StreamToolCall
} from '$lib/utils/stream-events';
import {
	mergeToolMetadata,
	citationNumbersInText,
	citationRecordsUsedInAnswer,
	parseToolMetadata,
	resolvedCitationNumbersForAnswer,
	serializeAnswerProvenance,
	serializeToolMetadata
} from '$lib/utils/tool-metadata';
import {
	getConversationReasoningEffort,
	parseReasoningEffort,
	reasoningEffortLabel,
	setConversationReasoningEffort
} from '$lib/server/reasoning';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import { checkRateLimit } from '$lib/server/rate-limit';
import {
	getConversationMessageProvenance,
	saveMessageProvenance
} from '$lib/server/db/message-provenance';
import { newId } from '$lib/utils/id';
import {
	mergeLatestResearchContract,
	type CitationRecord,
	type ConversationContext,
	type DocumentContext,
	type NewsroomContext
} from '@newscraft/shared';
import { getNewsroomProfile } from '$lib/server/documents/profiles';
import { getConversationDocumentService } from '$lib/server/documents/runtime';
import type { ConversationDocumentService } from '$lib/server/documents/service';
import {
	buildConversationContext,
	conversationContextProvenanceMessageIds,
	conversationContextCompatibilityMessage
} from '$lib/server/conversation-context';
import {
	answerForLatestUser,
	isLatestUnfinishedAssistant
} from '$lib/server/reply-operations';
import { resolveResearchFinishStatus } from '$lib/server/research-outcome';

interface Body {
	conversation_id?: string;
	content?: MessageContent;
	retry?: boolean;
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

function serializeUserDocumentIds(documentIds: string[]): string | null {
	return documentIds.length ? JSON.stringify({ document_ids: documentIds }) : null;
}

function parseUserDocumentIds(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as { document_ids?: unknown };
		if (!Array.isArray(parsed.document_ids)) return [];
		return Array.from(
			new Set(
				parsed.document_ids.filter(
					(documentId): documentId is string =>
						typeof documentId === 'string' && documentId.trim().length > 0
				)
			)
		).slice(0, 3);
	} catch {
		return [];
	}
}

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

function researchDiagnosticsFromTools(tools: StreamToolCall[]): Record<string, unknown> | null {
	const search = [...tools].reverse().find((tool) => tool.name === 'openai_web_search');
	if (!search?.result || typeof search.result !== 'object' || Array.isArray(search.result)) return null;
	const research = (search.result as Record<string, unknown>).research;
	if (!research || typeof research !== 'object' || Array.isArray(research)) return null;
	const value = research as Record<string, unknown>;
	const attempts = Array.isArray(value.attempts)
		? value.attempts.slice(0, 4).flatMap((attempt) => {
				if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return [];
				const item = attempt as Record<string, unknown>;
				return [
					{
						role: typeof item.role === 'string' ? item.role : 'unknown',
						provider: typeof item.provider === 'string' ? item.provider : 'unknown',
						status: typeof item.status === 'string' ? item.status : 'failed',
						latencyMs: typeof item.latencyMs === 'number' ? item.latencyMs : 0,
						sourceCount: typeof item.sourceCount === 'number' ? item.sourceCount : 0,
						...(typeof item.upstreamStatus === 'number'
							? { upstreamStatus: item.upstreamStatus }
							: {}),
						...(typeof item.failureCategory === 'string'
							? { failureCategory: item.failureCategory }
							: {})
					}
				];
			})
		: [];
	return {
		attempts,
		finalOutcome: typeof value.finalOutcome === 'string' ? value.finalOutcome : 'unknown'
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
	resumeClaimToken: number | null | undefined,
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
		if (!resumeClaimToken) throw error(409, 'resume claim lost');
		const row = await getMessageById(resumeMessageId);
		const metadata = parseToolMetadata(row?.toolCalls);
		const answerText = `${row ? contentText(parseContent(row.content)) : ''}\n\n${text}`.trim();
		const endedAt = Date.now();
		const provenanceJson = serializeAnswerProvenance({
			messageId: resumeMessageId,
			conversationId: convoId,
			tools: metadata.tools,
			sources: metadata.sources,
			citations: metadata.citations,
			startedAt,
			endedAt,
			assistantChars: answerText.length,
			answerText,
			done: true,
			finishStatus: 'failed',
			events: {},
			transport: 'local_gateway_failure',
			reasoningEffort: undefined,
			model: undefined
		});
		const committed = await finalizeResumedAssistantMessage({
			id: resumeMessageId,
			conversationId: convoId,
			claimToken: resumeClaimToken,
			mode: 'append',
			appendContent: `\n\n${text}`,
			toolCalls: serializeToolMetadata(metadata.tools, metadata.sources, metadata.citations),
			provenanceJson,
			partial: 0,
			now: endedAt
		});
		if (!committed) throw error(409, 'resume claim lost');
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
	const isRetry = body.retry === true;
	const isRegenerate = body.regenerate === true;
	if ([isResume, isRetry, isRegenerate].filter(Boolean).length > 1) {
		throw error(400, 'choose only one reply operation');
	}
	const accountId = locals.user.id;
	let convo = body.conversation_id ? await getConversation(accountId, body.conversation_id) : undefined;
	const isNew = !convo && !isResume && !isRetry && !isRegenerate;
	if (!convo) {
		if (isResume || isRetry || isRegenerate) throw error(404, 'conversation not found');
		convo = await createConversation(accountId);
	}
	const convoId = convo.id;
	let documentIds = Array.isArray(body.document_ids)
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
		retry: body.retry === true,
		resume: isResume,
		regenerate: body.regenerate === true,
		newConversation: isNew
	});

	let resumeMessageId: string | null = null;
	let resumeClaimToken: number | null = null;
	let visibleUserMessageId: string | null = null;
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
		const existingMessages = await getMessages(convoId);
		if (!isLatestUnfinishedAssistant(existingMessages, target.id)) {
			throw error(409, 'only the latest unfinished answer can be resumed');
		}
		resumeClaimToken = await claimPartialAssistantMessage(messageId, convoId);
		if (!resumeClaimToken) throw error(409, 'already resuming');
		resumeMessageId = messageId;
	} else if (isRegenerate || isRetry) {
		const existingMessages = await getMessages(convoId);
		const existingUser = [...existingMessages].reverse().find((message) => message.role === 'user');
		if (!existingUser) throw error(409, 'no user request is available for this operation');
		if (isRetry) {
			const expectedVisibleRequest = body.output_action
				? OUTPUT_ACTION_VISIBLE_REQUESTS[body.output_action]
				: body.content
					? contentText(body.content)
					: '';
			const persistedVisibleRequest = contentText(parseContent(existingUser.content));
			if (expectedVisibleRequest && expectedVisibleRequest !== persistedVisibleRequest) {
				throw error(409, 'the saved user request changed before retry');
			}
		}
		const existingAnswer = answerForLatestUser(existingMessages);
		if (existingAnswer) await deleteMessagesFrom(convoId, existingAnswer.id);
	} else {
		const outputActionPrompt = body.output_action ? OUTPUT_ACTION_PROMPTS[body.output_action] : undefined;
		const requestedContent = body.output_action
			? OUTPUT_ACTION_VISIBLE_REQUESTS[body.output_action]
			: body.content;
		const cleaned = sanitizeContent(requestedContent);
		if (cleaned == null) throw error(400, 'content required');
		if (typeof cleaned === 'string' && !cleaned.trim()) throw error(400, 'content required');
		let upstreamContent: MessageContent = outputActionUpstreamContent ?? cleaned;
		const visibleUserMessage = await addMessage({
			conversationId: convoId,
			role: 'user',
			content: cleaned,
			toolCalls: serializeUserDocumentIds(documentIds)
		});
		visibleUserMessageId = visibleUserMessage.id;
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

		if (upstreamContent !== cleaned && !outputActionPrompt) {
			body = { ...body, content: upstreamContent };
		}
	}

	const reasoningEffort = await getConversationReasoningEffort(convoId);
	const messages = await getMessages(convoId);
	const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
	if ((isResume || isRetry || isRegenerate) && !latestUserMessage) {
		throw error(409, 'no user request is available for this operation');
	}
	if (isRegenerate && documentIds.length === 0) {
		documentIds = parseUserDocumentIds(latestUserMessage?.toolCalls);
	}
	const provenanceMessageIds = conversationContextProvenanceMessageIds({
		messages,
		sourceMessageId: body.source_message_id
	});
	const provenance = await getConversationMessageProvenance(convoId, {
		messageIds: provenanceMessageIds,
		limit: provenanceMessageIds.length
	});
	const inheritedMetadata = body.output_action
		? parseToolMetadata(outputActionSource?.toolCalls)
		: null;
	const persistedUserRequest =
		isRegenerate || isRetry || isResume
			? contentText(parseContent(latestUserMessage?.content ?? ''))
			: '';
	const currentRequest = body.output_action
		? OUTPUT_ACTION_VISIBLE_REQUESTS[body.output_action]
		: body.content
			? contentText(body.content)
			: persistedUserRequest;
	const conversationContext: ConversationContext = buildConversationContext({
		messages,
		provenance,
		currentRequest,
		currentMessageId: visibleUserMessageId ?? latestUserMessage?.id,
		operation: body.output_action
			? 'transform'
			: isResume
				? 'resume'
				: isRetry
					? 'retry'
					: isRegenerate
						? 'regenerate'
						: 'send',
		outputAction: Boolean(body.output_action),
		sourceMessageId: body.source_message_id
	});
	recordChatDiagnostic(convoId, 'chat.history_built', {
		trace_id: traceId,
		messageCount: messages.length,
		conversationContextBytes: new TextEncoder().encode(JSON.stringify(conversationContext)).byteLength,
		currentMessageId: conversationContext.currentTurn?.messageId ?? null,
		operation: conversationContext.currentTurn?.operation ?? null,
		researchRequired: conversationContext.currentTurn?.researchRequired ?? false,
		freshness: conversationContext.currentTurn?.freshness ?? null,
		recentTurnCount: conversationContext.recentTurns?.length ?? 0,
		reasoningEffort
	});
	const completedHistoryMessages = messages.filter(
		(message) => message.role !== 'assistant' || message.partial !== 1
	);
	const historyMessages =
		body.output_action && outputActionSource && visibleUserMessageId
			? completedHistoryMessages.filter(
					(message) =>
						message.role === 'system' ||
						message.id === outputActionSource?.id ||
						message.id === visibleUserMessageId
				)
			: completedHistoryMessages;
	const history = historyMessages.map<AgentMessage>((m) => {
		const parsed = parseContent(m.content);
		return {
			role: m.role === 'tool' ? 'assistant' : (m.role as 'user' | 'assistant' | 'system'),
			content: toAgentContent(parsed)
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
	if (body.output_action) appendSystemInstruction(history, OUTPUT_ACTION_PROMPTS[body.output_action]);
	if (
		conversationContext.activeTopic ||
		conversationContext.lastSourceBackedAnswer ||
		conversationContext.claimStates?.length
	) {
		// Older harnesses ignore conversation_context. A tagged system message
		// preserves citation/correction state without mutating assistant prose.
		appendSystemInstruction(history, conversationContextCompatibilityMessage(conversationContext));
	}

	let researchContext: Awaited<ReturnType<typeof requestResearchContext>>;
	try {
		researchContext = await requestResearchContext({
			conversationId: convoId,
			orgId: convo.orgId,
			accountId,
			documentIds,
			query: currentRequest,
			traceId
		});
	} catch (cause) {
		if (cause instanceof NewsroomContextUnavailableError) {
			if (resumeMessageId) {
				return await localGatewayFailureResponse(
					convoId,
					'newsroom context unavailable',
					resumeMessageId,
					resumeClaimToken,
					traceId
				);
			}
			return localAssistantResponse(
				convoId,
				"I couldn't load your newsroom timezone, so I stopped before interpreting relative dates. Try again in a moment.",
				traceId
			);
		}
		throw cause;
	}
	if (conversationContext.currentTurn?.researchContract) {
		conversationContext.currentTurn.researchContract = mergeLatestResearchContract(
			conversationContext.currentTurn.researchContract,
			currentRequest,
			{
				homeMarket: researchContext.newsroomContext.homeMarket,
				timezone: researchContext.newsroomContext.timezone
			}
		);
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
				conversation_context: conversationContext,
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
					conversation_context: conversationContext,
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
			resumeClaimToken,
			traceId
		);
	}

	if (!upstream.ok || !upstream.body) {
		const text = await upstream.text().catch(() => '');
		return await localGatewayFailureResponse(
			convoId,
			`Agent ${upstream.status || 502}: ${text || upstream.statusText}`,
			resumeMessageId,
			resumeClaimToken,
			traceId
		);
	}
	const upstreamBody = upstream.body;

	let assistantBuf = '';
	let assistantReplacement: string | null = null;
	let done = false;
	let persistencePromise: Promise<Awaited<ReturnType<typeof getMessageById>>> | null = null;
	let sentDone = false;
	let activeController: ReadableStreamDefaultController<Uint8Array> | null = null;
	const streamState = new StreamEventState();
	const inheritedCitations = inheritedMetadata?.citations ?? [];
	const activeCitationRecords = () =>
		mergeToolMetadata(null, [], [], [...inheritedCitations, ...streamState.citationList()]).citations;
	const citationSanitizer = new StreamingCitationSanitizer(inheritedCitations);
	const streamStats: Record<string, number> = {};
	let upstreamModel: string | undefined;
	let preserveSanitizedAssistant: string | null = null;

	function canonicalAssistantText(): string {
		return sanitizeUnresolvedCitationMarkers(assistantBuf, activeCitationRecords());
	}

	function enqueueCitationDelta(controller: ReadableStreamDefaultController<Uint8Array>, delta: string): void {
		if (!delta) return;
		controller.enqueue(
			enc.encode(sseFrame('response.output_text.delta', JSON.stringify({ delta })))
		);
	}

	function enqueueCitationReplacement(
		controller: ReadableStreamDefaultController<Uint8Array>,
		content: string
	): void {
		controller.enqueue(enc.encode(sseFrame('agent.answer.replace', JSON.stringify({ content }))));
	}

	function tryEnqueueCitationBoundary(
		controller: ReadableStreamDefaultController<Uint8Array>,
		flush: () => string
	): void {
		const tail = flush();
		try {
			enqueueCitationDelta(controller, tail);
			const canonical = canonicalAssistantText();
			if (citationSanitizer.emitted && citationSanitizer.emitted !== canonical) {
				enqueueCitationReplacement(controller, canonical);
			}
			preserveSanitizedAssistant = canonical;
		} catch {
			// A consumer cancellation may close the controller before the route's
			// cancellation hook runs. Persistence still uses the same canonical value.
			preserveSanitizedAssistant = canonicalAssistantText();
		}
	}

	async function persistAssistant(finishStatus?: 'completed' | 'partial' | 'failed' | 'cancelled') {
		if (persistencePromise) return persistencePromise;
		persistencePromise = (async () => {
			// The stream boundary is defensive as well as the harness boundary:
			// provider-local or malformed markers cannot become durable authority
			// merely because an upstream event bypassed structured synthesis.
			assistantBuf = preserveSanitizedAssistant ?? canonicalAssistantText();
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
			const capturedCitations = body.output_action
				? citationRecordsUsedInAnswer(assistantBuf, captured.citations)
				: captured.citations;
			const resolvedFinishStatus = resolveResearchFinishStatus({
				requested: finishStatus,
				researchRequired: conversationContext.currentTurn?.researchRequired === true,
				sourceCount: capturedSources.length,
				citationCount: capturedCitations.length
			});
			if (resumeMessageId) {
				if (!resumeClaimToken) return await getMessageById(resumeMessageId);
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
				// A replacement resets the visible draft, but later deltas still belong
				// to that authoritative answer. Persist the complete post-replacement
				// buffer so the CAS commit cannot lose or duplicate the tail.
				const appendContent = assistantReplacement === null ? assistantBuf : '';
				const answerText =
					assistantReplacement !== null
						? assistantBuf
						: `${existingRow ? contentText(parseContent(existingRow.content)) : ''}${appendContent}`;
				const endedAt = Date.now();
				const provenanceJson = serializeAnswerProvenance({
					messageId: resumeMessageId,
					conversationId: convoId,
					tools: provenanceTools,
					sources: provenanceSources,
					citations: provenanceCitations,
					answerText,
					startedAt: requestStartedAt,
					endedAt,
					assistantChars: answerText.length,
					done,
					finishStatus: resolvedFinishStatus,
					events: streamStats,
					transport,
					reasoningEffort,
					model: upstreamModel
				});
				const committed = await finalizeResumedAssistantMessage({
					id: resumeMessageId,
					conversationId: convoId,
					claimToken: resumeClaimToken,
					mode: assistantReplacement !== null ? 'replace' : 'append',
					...(assistantReplacement !== null ? { content: assistantBuf } : { appendContent }),
					toolCalls: serializeToolMetadata(provenanceTools, provenanceSources, provenanceCitations),
					provenanceJson,
					partial: done ? 0 : 1,
					now: endedAt
				});
				// A retry that lost the claim observes the already-authoritative row;
				// it never appends its own draft or writes a second provenance record.
				return committed ?? (await getMessageById(resumeMessageId));
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
				finishStatus: resolvedFinishStatus,
				events: streamStats,
				transport,
				reasoningEffort,
				model: upstreamModel,
				traceId
			});
			return row;
		})();
		return persistencePromise;
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			activeController = controller;
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
						if (update.replace !== undefined) {
							assistantBuf = update.replace;
							assistantReplacement = update.replace;
							done = true;
						}
						if (update.delta) assistantBuf += update.delta;
						if (update.failed) throw new Error(update.failed);
						if (update.done) done = true;
					}
					if (ev.data === '[DONE]') {
						sentDone = true;
						continue;
					}
					const citationsForStream = activeCitationRecords();
					const releasedAfterCitation =
						ev.event === 'agent.citations'
							? citationSanitizer.setCitations(citationsForStream)
							: '';
					const safeEventData = sanitizeCitationEventData(
						ev.event,
						ev.data,
						citationsForStream,
						citationSanitizer
					);
					controller.enqueue(enc.encode(sseFrame(ev.event, safeEventData)));
					if (releasedAfterCitation) {
						controller.enqueue(
							enc.encode(
								sseFrame(
									'response.output_text.delta',
									JSON.stringify({ delta: releasedAfterCitation })
								)
							)
						);
					}
				}
			} catch (e) {
				recordChatDiagnostic(convoId, 'chat.stream_error', {
					trace_id: traceId,
					errorName: e instanceof Error ? e.name : 'Error',
					elapsedMs: Date.now() - requestStartedAt,
					assistantChars: assistantBuf.length,
					events: streamStats
				});
				tryEnqueueCitationBoundary(controller, () => citationSanitizer.abort());
				await persistAssistant('failed');
				controller.error(e);
				return;
			}

			// Do not let an unfinished marker disappear from the live stream while
			// persistence reconciles the raw accumulated buffer. The same sanitizer
			// is used here and in persistAssistant, so this tail is emitted exactly
			// once and has the same result as the durable answer.
			const citationTail = citationSanitizer.flush();
			enqueueCitationDelta(controller, citationTail);

			if (done && !assistantBuf.trim()) {
				const fallback = conversationContext.currentTurn?.researchRequired
					? "I couldn't complete the research with readable current sources right now. Please retry."
					: "I couldn't complete that reply right now. Please retry.";
				assistantBuf = fallback;
				controller.enqueue(
					enc.encode(sseFrame('response.output_text.delta', JSON.stringify({ delta: fallback })))
				);
			}
			const assistantRow = await persistAssistant(done ? 'completed' : 'partial');
			if (
				(assistantReplacement !== null || citationSanitizer.emitted) &&
				citationSanitizer.emitted !== assistantBuf
			) {
				enqueueCitationReplacement(controller, assistantBuf);
			}
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
				researchOutcome: conversationContext.currentTurn?.researchRequired
					? resolvedCitationCount > 0
						? 'sourced'
						: 'failed'
					: 'not_required',
				research: researchDiagnosticsFromTools(streamState.toolCalls()),
				events: streamStats
			});
			if (sentDone || done) controller.enqueue(enc.encode('data: [DONE]\n\n'));
			controller.close();
		},
			async cancel() {
			recordChatDiagnostic(convoId, 'chat.stream_cancel', {
				trace_id: traceId,
				elapsedMs: Date.now() - requestStartedAt,
				assistantChars: assistantBuf.length
			});
			upstreamAbort.abort();
			if (activeController) tryEnqueueCitationBoundary(activeController, () => citationSanitizer.abort());
			try {
				await persistAssistant('cancelled');
			} catch (error) {
				recordChatDiagnostic(convoId, 'chat.stream_cancel_persist_error', {
					trace_id: traceId,
					errorName: error instanceof Error ? error.name : 'Error',
					assistantChars: assistantBuf.length
				});
				throw error;
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
