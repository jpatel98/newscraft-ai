import { error, isHttpError, type RequestHandler } from '@sveltejs/kit';
import {
	deriveSessionId,
	deriveHermesTenantKey,
	buildHermesRunInput,
	startDurableHermesRun,
	HermesDurableOverloadError,
	gatewayHealth,
	type AgentMessage,
	type AgentContent,
	type AgentContentPart
} from '$lib/server/agent/transport';
import { selectCitationInheritanceToolCalls } from '$lib/server/agent/citation-inheritance';
import { expandAgentSkill, listAgentCommands } from '$lib/server/agent/bridge';
import {
	addMessage,
	claimPartialAssistantMessage,
	createConversation,
	deleteMessagesFrom,
	finalizePreparedAssistantMessage,
	finalizeResumedAssistantMessage,
	getConversation,
	getMessageById,
	getMessages,
	getPreparedDurableTurnStatus,
	parseContent,
	prepareDurableUserTurn,
	takeOverPreparedDurableTurn
} from '$lib/server/db/conversations';
import { contentText, type ChatCommand, type ContentPart, type AgentCommand, type MessageContent } from '$lib/types';
import { parseSlashCommand, type SlashParseResult } from '$lib/utils/slash';
import type { PersistedSource, StreamToolCall } from '$lib/utils/stream-events';
import {
	parseToolMetadata,
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
	conversationContextProvenanceMessageIds
} from '$lib/server/conversation-context';
import {
	answerForLatestUser,
	isLatestUnfinishedAssistant,
	resumeContinuationInstruction
} from '$lib/server/reply-operations';
import {
	CHAT_PERSISTENCE_TIMEOUT_MS,
	CHAT_RESEARCH_CONTEXT_TIMEOUT_MS,
	ChatPhaseTimeoutError,
	withChatTimeout
} from '$lib/server/chat-timeouts';
import {
	NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL,
	NEWSCRAFT_OCVO_WRITING_GUIDE,
	NEWSCRAFT_STANDALONE_OUTPUT_GUIDE,
	resolveConversationSystemPrompt
} from '$lib/server/agent/prompts';
import {
	createOrGetHermesRun,
	ensureHermesAssistantMessage,
	failQueuedHermesRun,
	getHermesRun,
	getHermesRunForAssistant,
	HermesRunRepositoryError
} from '$lib/server/db/hermes-runs';
import { hermesSubscriptionResponse } from '$lib/server/hermes-subscription';
import {
	summarizeDurableRunTelemetry,
	traceIdFromHermesInput
} from '$lib/server/durable-run-telemetry';

interface Body {
	conversation_id?: string;
	content?: MessageContent;
	retry?: boolean;
	regenerate?: boolean;
	resume?: boolean;
	message_id?: string;
	command?: ChatCommand;
	document_ids?: string[];
	output_action?: 'producer_brief' | 'thirty_second_script' | 'interview_questions' | 'copy_with_citations';
	source_message_id?: string;
	idempotency_key?: string;
}

// Agent caps the request body around 1 MB; keep some headroom for the
// surrounding JSON envelope, system prompt, and prior turns.
const MAX_REQUEST_BYTES = 950 * 1024;

async function readChatBody(request: Request): Promise<Body> {
	const reader = request.body?.getReader();
	if (!reader) throw error(400, 'invalid json');
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_REQUEST_BYTES) {
				await reader.cancel().catch(() => {});
				throw error(413, 'request too large — try fewer or smaller attachments');
			}
			chunks.push(chunk.value);
		}
		const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'JSON object required');
		return body as Body;
	} catch (cause) {
		if (isHttpError(cause)) throw cause;
		throw error(400, 'invalid json');
	} finally {
		reader.releaseLock();
	}
}
const OUTPUT_ACTION_PROMPTS: Record<NonNullable<Body['output_action']>, string> = {
	producer_brief:
		`${NEWSCRAFT_STANDALONE_OUTPUT_GUIDE}\n\nWrite a concise producer brief. Put the central news and essential background first. Then give the verified details, impact, response, confirmed next step, and unresolved editorial checks.`,
	thirty_second_script: NEWSCRAFT_OCVO_WRITING_GUIDE,
	interview_questions:
		`${NEWSCRAFT_STANDALONE_OUTPUT_GUIDE}\n\nDraft focused interview questions. Start with enough verified context to identify the subject and purpose of the interview. Probe the known facts, material gaps, disagreements, accountability, impact, and next steps.`,
	copy_with_citations:
		`${NEWSCRAFT_STANDALONE_OUTPUT_GUIDE}\n\nWrite clean publication-ready copy. Lead with the central news, establish the essential background, and keep each citation marker with the claim it supports.`
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

function sanitizeContent(c: MessageContent | undefined): MessageContent | null {
	if (c == null) return null;
	if (typeof c === 'string') return c;
	if (!Array.isArray(c)) throw error(400, 'Unsupported message content. Send text or an attached image.');
	const parts: ContentPart[] = [];
	for (const p of c) {
		if (!p || typeof p !== 'object') throw error(400, 'Invalid message attachment.');
		if (p.type === 'text' && typeof p.text === 'string') {
			parts.push({ type: 'text', text: p.text });
		} else if (
			p.type === 'image_url' &&
			p.image_url &&
			typeof p.image_url.url === 'string'
		) {
			if (!/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(p.image_url.url)) {
				throw error(400, 'Images must be attached as supported image data; remote image links are unavailable.');
			}
			parts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
		} else {
			throw error(400, 'Unsupported message attachment. Attach an image or upload a PDF through the document picker.');
		}
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

const enc = new TextEncoder();

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
					...(profile.preferredDomains.length ? { preferredDomains: profile.preferredDomains } : {})
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
		await withChatTimeout(saveMessageProvenance({
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
		}), CHAT_PERSISTENCE_TIMEOUT_MS, 'answer provenance persistence');
	} catch (err) {
		recordChatDiagnostic(input.conversationId, 'chat.provenance_error', {
			messageId: input.messageId,
			errorName: err instanceof Error ? err.name : 'Error',
			...(input.traceId ? { trace_id: input.traceId } : {})
		});
	}
}

async function localAssistantResponse(
	accountId: string,
	convoId: string,
	text: string,
	traceId: string,
	preparedAssistantMessageId?: string | null,
	preparedClaimToken?: number | null
): Promise<Response> {
	const startedAt = Date.now();
	recordChatDiagnostic(convoId, 'chat.local_response', {
		responseChars: text.length,
		trace_id: traceId
	});
	const row = await withChatTimeout(
		preparedAssistantMessageId
			? finalizePreparedAssistantMessage({
					accountId,
					conversationId: convoId,
					messageId: preparedAssistantMessageId,
					claimToken: preparedClaimToken as number,
					content: text
				})
			: addMessage({ conversationId: convoId, role: 'assistant', content: text }),
		CHAT_PERSISTENCE_TIMEOUT_MS,
		'assistant persistence'
	);
	if (!row) throw error(409, 'assistant turn changed before finalization');
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

async function waitForPreparedHermesRun(
	accountId: string,
	conversationId: string,
	assistantMessageId: string,
	signal: AbortSignal,
	timeoutMs = 45_000
) {
	const deadline = Date.now() + timeoutMs;
	while (!signal.aborted && Date.now() < deadline) {
		const status = await getPreparedDurableTurnStatus(accountId, conversationId, assistantMessageId);
		if (status?.runId) {
			const run = await getHermesRun(accountId, status.runId);
			if (run) return { run, finalizedText: null };
		}
		if (status?.partial === 0) return { run: null, finalizedText: status.content };
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
	}
	return null;
}

function gatewayUnavailableMessage(detail: string): string {
	if (/web extraction is not configured/i.test(detail)) {
		return [
			'The research service is reachable, but web retrieval is not configured yet.',
			'Your message was saved. Research will work after the retrieval-enabled research service is ready.'
		].join('\n\n');
	}
	if (/web extraction is not ready|readiness check failed/i.test(detail)) {
		return [
			'The research service is reachable, but its web retrieval backend is not ready.',
			'Your message was saved. Try research again after the service reports ready.'
		].join('\n\n');
	}
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
	accountId: string,
	convoId: string,
	detail: string,
	resumeMessageId: string | null | undefined,
	resumeClaimToken: number | null | undefined,
	traceId: string,
	preparedAssistantMessageId?: string | null,
	preparedClaimToken?: number | null
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
		let row: Awaited<ReturnType<typeof getMessageById>>;
		try {
			row = await withChatTimeout(
				getMessageById(resumeMessageId),
				CHAT_PERSISTENCE_TIMEOUT_MS,
				'gateway-failure message lookup'
			);
		} catch (lookupError) {
			recordChatDiagnostic(convoId, 'chat.gateway_failure_persistence_error', {
				trace_id: traceId,
				errorName: lookupError instanceof Error ? lookupError.name : 'Error',
				phase: 'lookup'
			});
			return localTextStream(convoId, `\n\n${text}`, traceId);
		}
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
		let committed: Awaited<ReturnType<typeof finalizeResumedAssistantMessage>>;
		try {
			committed = await withChatTimeout(
				finalizeResumedAssistantMessage({
					id: resumeMessageId,
					conversationId: convoId,
					claimToken: resumeClaimToken,
					mode: 'append',
					appendContent: `\n\n${text}`,
					toolCalls: serializeToolMetadata(metadata.tools, metadata.sources, metadata.citations,
						{ plan: metadata.plan, decisions: metadata.decisions }),
					provenanceJson,
					partial: 0,
					now: endedAt
				}),
				CHAT_PERSISTENCE_TIMEOUT_MS,
				'gateway-failure finalization'
			);
		} catch (finalizationError) {
			recordChatDiagnostic(convoId, 'chat.gateway_failure_persistence_error', {
				trace_id: traceId,
				errorName: finalizationError instanceof Error ? finalizationError.name : 'Error',
				phase: 'finalization'
			});
			return localTextStream(convoId, `\n\n${text}`, traceId);
		}
		if (!committed) throw error(409, 'resume claim lost');
		return localTextStream(convoId, `\n\n${text}`, traceId);
	}
	return localAssistantResponse(
		accountId,
		convoId,
		text,
		traceId,
		preparedAssistantMessageId,
		preparedClaimToken
	);
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
			? `NewsCraft is reachable. Status ${health.status}.`
			: `NewsCraft is not reachable right now. ${health.body}`;
	}
	if (command.slash === '/profile') {
		const skillCount = commands.filter((cmd) => cmd.kind === 'skill' && cmd.enabled).length;
		return `Profile: newscraft-agent\nInstalled skills: ${skillCount}`;
	}
	if (command.slash === '/feedback') {
		return 'Use `/feedback` in the chat composer to open the feedback capture form for this thread.';
	}
	return 'This command is not available from the web UI yet.';
}

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const requestAcceptedAt = Date.now();
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

	let body = await readChatBody(request);
	// The request hook owns trace creation. Ignore browser JSON and headers.
	const traceId = locals.traceId || newId();

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
	if (body.idempotency_key !== undefined && typeof body.idempotency_key !== 'string') {
		throw error(400, 'idempotency key must be a string');
	}
	const suppliedDurableKey = body.idempotency_key?.trim();
	if (suppliedDurableKey) {
		if (suppliedDurableKey.length > 256) throw error(400, 'idempotency key is too long');
		const existing = await getHermesRun(accountId, suppliedDurableKey, 'idempotency');
		if (existing) {
			if (existing.conversationId !== convoId) throw error(409, 'idempotency key belongs to another conversation');
			return hermesSubscriptionResponse({
				request,
				accountId,
				runId: existing.id,
				afterCursor: 0
			});
		}
	}
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
		request_acceptance_ms: Math.max(0, requestStartedAt - requestAcceptedAt),
		contentLength: len,
		retry: body.retry === true,
		retry_count: body.retry === true ? 1 : 0,
		resume: isResume,
		regenerate: body.regenerate === true,
		newConversation: isNew
	});

	let resumeMessageId: string | null = null;
	let resumeClaimToken: number | null = null;
	let resumeDraftText: string | undefined;
	let visibleUserMessageId: string | null = null;
	let preparedAssistantMessageId: string | null = null;
	let preparedClaimToken: number | null = null;
	let outputActionSource:
		| Awaited<ReturnType<typeof getMessageById>>
		| undefined;
	let outputActionUpstreamContent: string | undefined;
	let durableRunCreated = false;
	let ownsPreparedTurn = false;
	try {
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
		const activeRun = await getHermesRunForAssistant(accountId, convoId, messageId);
		if (activeRun) {
			return hermesSubscriptionResponse({ request, accountId, runId: activeRun.id, afterCursor: 0 });
		}
		resumeClaimToken = await claimPartialAssistantMessage(messageId, convoId);
		if (!resumeClaimToken) throw error(409, 'already resuming');
		resumeMessageId = messageId;
		resumeDraftText = contentText(parseContent(target.content));
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
		const parsedVisibleCommand = typeof cleaned === 'string' ? parseSlashCommand(cleaned) : null;
		const preparedTurn = !parsedVisibleCommand
			? await prepareDurableUserTurn({
					accountId,
					conversationId: convoId,
					content: cleaned,
					dedupeKey: body.output_action
						? `output:${body.output_action}:${body.source_message_id || ''}`
						: 'send',
					toolCalls: serializeUserDocumentIds(documentIds)
				})
			: null;
		const visibleUserMessage = preparedTurn?.user ?? await addMessage({
			conversationId: convoId,
			role: 'user',
			content: cleaned,
			toolCalls: serializeUserDocumentIds(documentIds)
		});
		visibleUserMessageId = visibleUserMessage.id;
		preparedAssistantMessageId = preparedTurn?.assistant.id ?? null;
		preparedClaimToken = preparedTurn?.claimToken ?? null;
		ownsPreparedTurn = preparedTurn?.created === true;
		if (preparedTurn && !preparedTurn.created) {
			const existingRun = await waitForPreparedHermesRun(
				accountId,
				convoId,
				preparedTurn.assistant.id,
				request.signal
			);
			if (existingRun?.run) {
				return hermesSubscriptionResponse({
					request,
					accountId,
					runId: existingRun.run.id,
					afterCursor: 0
				});
			}
			if (existingRun?.finalizedText != null) {
				return localTextStream(
					convoId,
					contentText(parseContent(existingRun.finalizedText)),
					traceId
				);
			}
			const takeoverToken = await takeOverPreparedDurableTurn({
				accountId,
				conversationId: convoId,
				messageId: preparedTurn.assistant.id,
				staleBefore: Date.now() - 45_000
			});
			if (takeoverToken) {
				preparedClaimToken = takeoverToken;
				ownsPreparedTurn = true;
			} else {
				throw error(409, 'this answer is already starting');
			}
		}
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
						accountId,
						convoId,
						`I don't recognize ${parsed.slash}. Use /commands to browse available commands, or remove the slash to send it as normal text.`,
						traceId
					);
				}
				if (command.kind === 'builtin') {
					return localAssistantResponse(
						accountId,
						convoId,
						await builtinResponse(command, commands, parsed.args, convoId),
						traceId
					);
				}
				if (!command.enabled) {
					return localAssistantResponse(
						accountId,
						convoId,
						command.blockedReason || 'This command is not available from the web UI yet.',
						traceId
					);
				}
				const expanded = await expandAgentSkill(command.slash, parsed.args, convoId);
				if (!expanded.trim()) {
					return localAssistantResponse(
						accountId,
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
	const inheritedToolCalls = selectCitationInheritanceToolCalls({
		messages,
		...(body.output_action
			? { outputActionSourceToolCalls: outputActionSource?.toolCalls ?? null }
			: {}),
		resumeMessageId
	});
	const contextualCitations = conversationContext.lastSourceBackedAnswer?.citations ?? [];
	const inheritedMetadata = inheritedToolCalls
		? parseToolMetadata(inheritedToolCalls)
		: !body.output_action && !isResume && !isRetry && !isRegenerate && contextualCitations.length
			? { ...parseToolMetadata(null), citations: contextualCitations }
			: null;
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

	const override = resolveConversationSystemPrompt(convo.systemPrompt);
	if (override) {
		const idx = history.findIndex((m) => m.role === 'system');
		const sys: AgentMessage = { role: 'system', content: override };
		if (idx >= 0) history[idx] = sys;
		else history.unshift(sys);
	}
	appendSystemInstruction(history, NEWSCRAFT_INTERACTIVE_TOOL_PROTOCOL);
	if (isResume && resumeMessageId) {
		const partialMessage = messages.find((message) => message.id === resumeMessageId);
		appendSystemInstruction(
			history,
			resumeContinuationInstruction(
				partialMessage ? contentText(parseContent(partialMessage.content)) : ''
			)
		);
	}
	if (body.output_action) appendSystemInstruction(history, OUTPUT_ACTION_PROMPTS[body.output_action]);
	// The research agent consumes conversation_context through AG-UI context. Do not repeat
	// the prior answer, corrections and sources in a compatibility system message.

	let researchContext: Awaited<ReturnType<typeof requestResearchContext>>;
	try {
		researchContext = await withChatTimeout(
			requestResearchContext({
				conversationId: convoId,
				orgId: convo.orgId,
				accountId,
				documentIds,
				query: currentRequest,
				traceId
			}),
			CHAT_RESEARCH_CONTEXT_TIMEOUT_MS,
			'research context'
		);
	} catch (cause) {
		if (cause instanceof NewsroomContextUnavailableError) {
			if (resumeMessageId) {
				return await localGatewayFailureResponse(
					accountId,
					convoId,
					'newsroom context unavailable',
					resumeMessageId,
					resumeClaimToken,
					traceId
				);
			}
			return localAssistantResponse(
				accountId,
				convoId,
				"I couldn't load your newsroom timezone, so I stopped before interpreting relative dates. Try again in a moment.",
				traceId,
				preparedAssistantMessageId,
				preparedClaimToken
			);
		}
		if (!(cause instanceof ChatPhaseTimeoutError)) throw cause;
		return await localGatewayFailureResponse(
			accountId,
			convoId,
			cause instanceof Error ? cause.message : String(cause),
			resumeMessageId,
			resumeClaimToken,
			traceId,
			preparedAssistantMessageId,
			preparedClaimToken
		);
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
	const researchToolsEnabled =
		conversationContext.currentTurn?.researchRequired === true ||
		conversationContext.currentTurn?.researchAllowed === true;

	const sessionId = deriveSessionId(history, `${accountId}:${convoId}`);
	const idempotencyKey =
		suppliedDurableKey ||
		(preparedAssistantMessageId
			? `hermes:${convoId}:${preparedAssistantMessageId}:send`
			: undefined) ||
		`hermes:${convoId}:${resumeMessageId || visibleUserMessageId || latestUserMessage?.id || 'turn'}:${body.output_action || (isResume ? `resume-${resumeClaimToken}` : isRetry ? 'retry' : isRegenerate ? 'regenerate' : 'send')}`;
	if (idempotencyKey.length > 256) throw error(400, 'idempotency key is too long');
	let assistantMessageId = resumeMessageId || preparedAssistantMessageId;
	if (!assistantMessageId) {
		assistantMessageId = await ensureHermesAssistantMessage(accountId, convoId, idempotencyKey);
	}
	const candidateRunId = newId();
	const built = buildHermesRunInput(
		{
			messages: history,
			stream: true,
			reasoning_effort: reasoningEffort,
			newsroom_context: researchContext.newsroomContext,
			conversation_context: conversationContext,
			documents: researchContext.documents
		},
		sessionId,
		candidateRunId,
		{
			recordSources: true,
			webExtractConfigured: researchToolsEnabled,
			seededCitations: inheritedMetadata?.citations ?? [],
			traceId
		}
	);
	let durableRun: Awaited<ReturnType<typeof createOrGetHermesRun>>['run'];
	let created = false;
	try {
		({ run: durableRun, created } = await createOrGetHermesRun({
			id: candidateRunId,
			accountId,
			orgId: convo.orgId,
			conversationId: convoId,
			userMessageId: visibleUserMessageId ?? latestUserMessage?.id ?? null,
			assistantMessageId,
			preparedClaimToken: preparedClaimToken ?? resumeClaimToken ?? undefined,
			idempotencyKey,
			tenantKey: deriveHermesTenantKey(accountId),
			sessionId,
			inputJson: JSON.stringify(built.input),
			seededCitationsJson: JSON.stringify(built.seededCitations),
			seededAnswerText: resumeDraftText
		}));
		durableRunCreated = true;
		if (created) {
			recordChatDiagnostic(convoId, 'chat.durable.accepted', {
				trace_id: traceId,
				request_acceptance_ms: Math.max(0, durableRun.createdAt - requestAcceptedAt),
				initial_state: durableRun.state
			});
		}
	} catch (cause) {
		if (cause instanceof HermesRunRepositoryError && cause.code === 'cross_account') {
			throw error(404, 'conversation not found');
		}
		throw cause;
	}
	if (created || durableRun.state === 'queued') {
		const durableTraceId = traceIdFromHermesInput(durableRun.inputJson) || undefined;
		try {
			let durableInput = built.input;
			let durableSeededCitations = built.seededCitations;
			if (!created) {
				// A concurrent idempotent request has the same saved run but a
				// different candidate input/run ID. Restart the saved job with
				// its persisted input so the worker binding remains exact.
				const savedInput = JSON.parse(durableRun.inputJson) as typeof built.input;
				if (!savedInput || typeof savedInput !== 'object') throw new Error('saved durable input is invalid');
				durableInput = savedInput;
				const savedCitations = JSON.parse(durableRun.seededCitationsJson) as unknown;
				if (Array.isArray(savedCitations)) durableSeededCitations = savedCitations as typeof built.seededCitations;
			}
			await startDurableHermesRun({
				runId: durableRun.id,
				accountId,
				tenantKey: durableRun.tenantKey,
				input: durableInput,
				seededCitations: durableSeededCitations,
				traceId: durableTraceId
			});
		} catch (cause) {
			const overloaded = cause instanceof HermesDurableOverloadError;
			durableRun = await failQueuedHermesRun(
				accountId,
				durableRun.id,
				overloaded ? 'Research service is temporarily at capacity. Try again shortly.' : undefined,
				overloaded ? 'overload' : 'start'
			);
			recordChatDiagnostic(
				convoId,
				'chat.durable.terminal',
					summarizeDurableRunTelemetry(durableRun, [], {
						requestAcceptanceMs: Math.max(0, durableRun.createdAt - requestAcceptedAt),
						failureClass: overloaded ? 'overload' : 'start'
					}),
					{ id: `durable-terminal:${durableRun.id}` }
				);
		}
	}
	return hermesSubscriptionResponse({
		request,
		accountId,
		runId: durableRun.id,
		afterCursor: 0
	});

	} catch (cause) {
		if (preparedAssistantMessageId && ownsPreparedTurn && !durableRunCreated) {
			recordChatDiagnostic(convoId, 'chat.durable_preflight_failed', {
				trace_id: traceId,
				errorName: cause instanceof Error ? cause.name : 'Error'
			});
			return localAssistantResponse(
				accountId,
				convoId,
				"I couldn't start this answer. Your request was saved. Try again.",
				traceId,
				preparedAssistantMessageId,
				preparedClaimToken
			);
		}
		throw cause;
	}
};
