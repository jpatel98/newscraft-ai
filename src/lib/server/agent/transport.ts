import { env } from '$env/dynamic/private';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
	HERMES_TOOLSET,
	type GatewayChatCompletionRequest,
	type GatewayChatMessage,
	type GatewayContent,
	type GatewayContentPart,
	type HermesAguiMessage,
	type HermesContextEntry,
	type HermesRunInput,
	type CitationRecord,
	type RetrievalProvenance
} from '@newscraft/shared';

export type AgentContentPart = GatewayContentPart;
export type AgentContent = GatewayContent;
export type AgentMessage = GatewayChatMessage;
export type AgentChatRequest = GatewayChatCompletionRequest;

export interface GatewayHealth {
	ok: boolean;
	/** Required Hermes core readiness. Optional tool providers do not affect it. */
	requiredReady: boolean;
	/** Whether the optional retrieval path can serve document-backed work. */
	webExtractionReady: boolean;
	/** Opaque Hermes process marker. Only surfaced in authenticated health details. */
	processInstanceId: string | null;
	providers: {
		browser: boolean | null;
		webResearch: boolean | null;
		webExtraction: boolean | null;
		webLeadVerification: boolean | null;
	};
	status: number;
	body: string;
	url: string;
	json: unknown | null;
	service: string | null;
}

export interface HermesRequestOptions {
	signal?: AbortSignal;
	/** Authenticated NewsCraft account id. Never comes from the browser. */
	accountId?: string;
	sessionId?: string;
	traceId?: string;
	recordSources?: boolean;
	requireWebExtraction?: boolean;
}

interface RawSseFrame {
	event: string;
	data: string;
}

interface HermesNormalizationState {
	toolArguments: Map<string, string>;
	toolNames: Map<string, string>;
	citationNumbers: Map<string, number>;
	citationUrls: Map<number, string>;
	recordedSources: Set<string>;
	nextCitationNumber: number;
	browserSource: { url: string; title: string } | null;
	currentTextMessageId: string | null;
	currentText: string;
	closedTextMessages: Array<{ id: string; content: string }>;
	retrievalByUrl: Map<string, RetrievalProvenance>;
}

type SeededCitation = CitationRecord;

interface BuiltRunInput {
	input: HermesRunInput;
	seededCitations: SeededCitation[];
}

const DEFAULT_MODEL = 'hermes-chat';
const SERVICE_NAME = 'newscraft-hermes-chat';
const TRACE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const CITATION_SOURCE_TYPES = new Set([
	'official',
	'primary',
	'news_report',
	'social_post',
	'user_document',
	'commercial',
	'unknown'
]);
const NEWSCRAFT_SOURCE_WRITER = {
	name: 'record_newscraft_source',
	stateKey: 'newscraftSources',
	arg: 'source',
	mode: 'append',
	description:
		'Record one source after you directly read it. Use the exact citation number in your final answer.',
	parameters: {
		type: 'object',
		properties: {
			source: {
				type: 'object',
				properties: {
					citationNumber: {
						type: 'integer',
						minimum: 1,
						description: 'The exact bracket number used for this source in the final answer.'
					},
					title: { type: 'string', description: 'The title shown on the source page.' },
					url: { type: 'string', description: 'The exact HTTP or HTTPS page URL that you read.' },
					publicationDate: {
						type: 'string',
						description: 'The publication or update date shown by the source, or an empty string.'
					},
					sourceType: {
						type: 'string',
						enum: [...CITATION_SOURCE_TYPES],
						description: 'The source category.'
					},
					supportingExcerpt: {
						type: 'string',
						description: 'A short exact excerpt from the page that supports the cited claim.'
					},
					retrieval: {
						type: 'object',
						description: 'Optional NewsCraft retrieval provenance. Keep the original URL as the source URL.',
						properties: {
							originalUrl: { type: 'string' },
							retrievedUrl: { type: 'string' },
							archivedUrl: { type: 'string' },
							captureTimestamp: { type: 'string' },
							pageTimestamp: { type: 'string' },
							publishedAt: { type: 'string' },
							updatedAt: { type: 'string' },
							retrievalTime: { type: 'string' },
							fallbackReason: { type: 'string' },
							retrievalMode: { type: 'string' },
							pageQuality: { type: 'string' },
							evidenceStatus: { type: 'string' },
							rejectionReason: { type: 'string' },
							timestampStatus: { type: 'string' },
							requestCount: { type: 'integer' },
							backend: { type: 'string' }
						},
						additionalProperties: false
					}
				},
				required: ['citationNumber', 'title', 'url', 'publicationDate', 'sourceType', 'supportingExcerpt'],
				additionalProperties: false
			}
		},
		required: ['source'],
		additionalProperties: false
	}
} as const;

function hermesUrl(): string {
	const value = (env.NEWSCRAFT_HERMES_URL || '').trim().replace(/\/$/, '');
	if (!value) throw new Error('Hermes is not configured. Set NEWSCRAFT_HERMES_URL.');
	return value;
}

function hermesToken(): string {
	const value = (env.NEWSCRAFT_HERMES_API_TOKEN || '').trim();
	if (!value) {
		throw new Error('Hermes authentication is not configured. Set NEWSCRAFT_HERMES_API_TOKEN.');
	}
	return value;
}

function hermesTenantSecret(): string {
	const value = (env.NEWSCRAFT_HERMES_TENANT_SECRET || '').trim();
	if (!value) {
		throw new Error(
			'Hermes tenant isolation is not configured. Set NEWSCRAFT_HERMES_TENANT_SECRET.'
		);
	}
	if (value.length < 32) {
		throw new Error('NEWSCRAFT_HERMES_TENANT_SECRET must contain at least 32 characters.');
	}
	return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function streamedString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJson(value: string): unknown | null {
	if (!value.trim()) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const direct = parseJson(value);
	if (direct !== null) return direct;
	const untrusted = value.match(/<untrusted_tool_result[^>]*>([\s\S]*?)<\/untrusted_tool_result>/i)?.[1];
	if (untrusted) {
		const parsed = parseJson(untrusted.trim());
		if (parsed !== null) return parsed;
	}
	const firstBrace = value.indexOf('{');
	const lastBrace = value.lastIndexOf('}');
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		const embedded = parseJson(value.slice(firstBrace, lastBrace + 1));
		if (embedded !== null) return embedded;
	}
	return value;
}

function flattenContent(content: AgentContent | undefined): string {
	if (!content) return '';
	if (typeof content === 'string') return content;
	return content
		.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

function toAguiMessage(message: GatewayChatMessage, index: number, runId: string): HermesAguiMessage {
	const converted: HermesAguiMessage = {
		id: `${runId}-message-${index + 1}`,
		role: message.role,
		content: message.content
	};
	if (message.role === 'tool' && message.tool_call_id) converted.toolCallId = message.tool_call_id;
	const withCalls = message as GatewayChatMessage & { tool_calls?: Array<Record<string, unknown>> };
	if (message.role === 'assistant' && Array.isArray(withCalls.tool_calls)) {
		converted.toolCalls = withCalls.tool_calls;
	}
	return converted;
}

function contextEntry(description: string, value: unknown): HermesContextEntry | null {
	if (value === undefined || value === null) return null;
	try {
		const serialized = typeof value === 'string' ? value : JSON.stringify(value);
		return serialized ? { description, value: serialized } : null;
	} catch {
		return null;
	}
}

function documentCitationContext(documents: AgentChatRequest['documents'], startNumber = 1): {
	context: unknown;
	citations: SeededCitation[];
} {
	let citationNumber = startNumber;
	const citations: SeededCitation[] = [];
	const context = (documents || []).map((document) => ({
		id: document.id,
		filename: document.filename,
		pageCount: document.pageCount,
		pages: document.pages.map((page) => {
			const current = citationNumber++;
			const url = document.downloadUrl || `document://${encodeURIComponent(document.id)}`;
			citations.push({
				citationNumber: current,
				title: `${document.filename}, page ${page.pageNumber}`,
				url,
				domain: 'Attached document',
				publicationDate: null,
				sourceType: 'user_document',
				supportingExcerpt: compactExcerpt(page.text),
				documentPage: page.pageNumber
			});
			return { pageNumber: page.pageNumber, citationNumber: current, text: page.text };
		})
	}));
	return { context, citations: citations.filter((citation) => citation.supportingExcerpt) };
}

function buildRunInput(
	body: AgentChatRequest,
	threadId: string,
	runId: string,
	recordSources = true,
	webExtractConfigured = false,
	seededCitations: ReadonlyArray<CitationRecord> = [],
	traceIdValue?: string
): BuiltRunInput {
	const traceId = traceHeader(traceIdValue) || randomUUID();
	const highestSeededNumber = seededCitations.reduce(
		(highest, citation) => Math.max(highest, citation.citationNumber),
		0
	);
	const documents = documentCitationContext(body.documents, highestSeededNumber + 1);
	const allSeededCitations = [...seededCitations, ...documents.citations];
	const context = [
		contextEntry('Newsroom context', body.newsroom_context),
		contextEntry('Conversation context', body.conversation_context),
		contextEntry('Private document excerpts with exact citation numbers', documents.context)
	].filter((entry): entry is HermesContextEntry => Boolean(entry));
	return {
		input: {
			threadId,
			runId,
			trace_id: traceId,
			state: { newscraftSources: [] },
			messages: body.messages.map((message, index) => toAguiMessage(message, index, runId)),
			tools: [],
			context,
			forwardedProps: {
				source: 'newscraft',
					operation: 'chat',
				citationStartNumber:
					allSeededCitations.reduce(
						(highest, citation) => Math.max(highest, citation.citationNumber),
						0
					) + 1,
					webExtractConfigured,
					retrievalVerificationTool: 'verify_this_lead',
					retrievalBackend: 'newscraft-local',
				retrievalMaxUrls: 5,
				archiveFallback: 'wayback',
				stateWriterTools: recordSources ? [NEWSCRAFT_SOURCE_WRITER] : []
			}
		},
		seededCitations: allSeededCitations
	};
}

/** The browser cannot choose or share a Hermes session key. */
export function deriveSessionId(messages: AgentMessage[], scope = ''): string {
	const system = flattenContent(messages.find((message) => message.role === 'system')?.content);
	const firstUser = flattenContent(messages.find((message) => message.role === 'user')?.content);
	return createHash('sha256')
		.update(scope)
		.update('\0')
		.update(system)
		.update('\0')
		.update(firstUser)
		.digest('hex')
		.slice(0, 32);
}

/** Derive the opaque tenant namespace sent to the isolated Hermes service. */
export function deriveHermesTenantKey(accountId: string): string {
	const normalized = accountId.trim();
	if (!normalized) throw new Error('Hermes requires an authenticated account scope.');
	return createHmac('sha256', hermesTenantSecret())
		.update('newscraft-hermes-tenant:v1\0')
		.update(normalized)
	.digest('base64url');
}

function traceHeader(value: string | undefined): string | undefined {
	if (typeof value !== 'string') return undefined;
	const cleaned = value.trim();
	return TRACE_ID_RE.test(cleaned) ? cleaned : undefined;
}

function requestHeaders(options: HermesRequestOptions): Record<string, string> {
	const token = hermesToken();
	const traceId = traceHeader(options.traceId);
	const tenantKey = deriveHermesTenantKey(options.accountId || '');
	return {
		'content-type': 'application/json',
		accept: 'text/event-stream',
		authorization: `Bearer ${token}`,
		'x-hermes-session-token': token,
		'x-newscraft-tenant-key': tenantKey,
		...(traceId ? { 'x-request-id': traceId, 'x-trace-id': traceId } : {})
	};
}

function sseFrame(event: string, data: string): string {
	let output = event && event !== 'message' ? `event: ${event}\n` : '';
	for (const line of data.split(/\r?\n/)) output += `data: ${line}\n`;
	return `${output}\n`;
}

function parseSseFrame(frame: string): RawSseFrame | null {
	let event = 'message';
	const data: string[] = [];
	for (const line of frame.split(/\r?\n/)) {
		if (!line || line.startsWith(':')) continue;
		if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
		else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
	}
	return data.length ? { event, data: data.join('\n') } : null;
}

function eventType(frame: RawSseFrame, payload: Record<string, unknown> | null): string {
	return (stringValue(payload?.type) || frame.event || 'MESSAGE').replace(/[- ]/g, '_').toUpperCase();
}

function toolCallId(payload: Record<string, unknown>): string | undefined {
	return stringValue(payload.toolCallId ?? payload.tool_call_id ?? payload.callId ?? payload.call_id ?? payload.id);
}

function toolCallName(payload: Record<string, unknown>): string | undefined {
	return stringValue(payload.toolCallName ?? payload.tool_call_name ?? payload.name);
}

function errorMessage(payload: Record<string, unknown>): string {
	const nested = objectValue(payload.error);
	return (
		stringValue(nested?.message) ||
		stringValue(payload.message) ||
		stringValue(payload.error) ||
		'Hermes returned an agent error.'
	);
}

function canonicalUrl(value: string): string {
	try {
		const url = new URL(value);
		url.hash = '';
		return url.toString();
	} catch {
		return value;
	}
}

function sourceDomain(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return 'Unknown source';
	}
}

function compactExcerpt(value: unknown): string {
	const text = stringValue(value)
		?.replace(/<!--\s*newscraft-retrieval:v1:[A-Za-z0-9_-]+\s*-->/g, ' ')
		?.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	return (text || '').slice(0, 1_200);
}

function retrievalFromContent(value: unknown): RetrievalProvenance | undefined {
	const text = stringValue(value);
	const encoded = text?.match(/<!--\s*newscraft-retrieval:v1:([A-Za-z0-9_-]+)\s*-->/)?.[1];
	if (!encoded) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
		if (!objectValue(parsed) || typeof parsed.originalUrl !== 'string') return undefined;
		return parsed as RetrievalProvenance;
	} catch {
		return undefined;
	}
}

function rememberRetrieval(
	state: HermesNormalizationState,
	url: string,
	retrieval: RetrievalProvenance
): void {
	for (const identity of [url, retrieval.originalUrl, retrieval.retrievedUrl, retrieval.archivedUrl]) {
		if (identity) state.retrievalByUrl.set(canonicalUrl(identity), retrieval);
	}
}

function assignCitationNumber(
	url: string,
	requested: unknown,
	state: HermesNormalizationState
): number {
	const canonical = canonicalUrl(url);
	const existing = state.citationNumbers.get(canonical);
	if (existing) return existing;
	const preferred = integerValue(requested);
	let number = preferred && !state.citationUrls.has(preferred) ? preferred : state.nextCitationNumber;
	while (state.citationUrls.has(number)) number += 1;
	state.citationNumbers.set(canonical, number);
	state.citationUrls.set(number, canonical);
	state.nextCitationNumber = Math.max(state.nextCitationNumber, number + 1);
	return number;
}

function extractedSourceFrames(result: unknown, state: HermesNormalizationState): string[] {
	const parsed = parseMaybeJson(result);
	const root = objectValue(parsed);
	const rawResults = Array.isArray(root?.results) ? root.results : [];
	const frames: string[] = [];

	for (const raw of rawResults) {
		const item = objectValue(raw);
		const url = stringValue(item?.url);
		const retrieval = retrievalFromContent(item?.content);
		if (item && url && /^https?:\/\//i.test(url) && retrieval) rememberRetrieval(state, url, retrieval);
		const content = compactExcerpt(item?.supportingExcerpt ?? item?.supporting_excerpt ?? item?.content);
		if (!item || !url || !/^https?:\/\//i.test(url) || stringValue(item.error) || !content) continue;
		if (!retrieval || retrieval.evidenceStatus !== 'accepted') {
			// A raw extractor result has no timestamp/provenance contract. It is
			// useful tool output, but it cannot become NewsCraft evidence.
			continue;
		}
		const title = stringValue(item.title) || url;
		const domain = sourceDomain(url);
		const publicationDate = retrieval.pageTimestamp || null;
		frames.push(
			sseFrame(
				'agent.source.read',
				JSON.stringify({
					source: {
						id: canonicalUrl(url),
						url,
						title,
						domain,
						status: 'read',
						detail:
							retrieval.retrievalMode === 'archive'
								? 'NewsCraft read the Wayback copy after the live page was blocked.'
								: 'NewsCraft verified and read this page.',
						verified: true,
						currentVerified: false,
						temporalScope: null,
						publishedAt: retrieval.publishedAt || publicationDate,
						updatedAt: retrieval.updatedAt || null,
						eventAt: retrieval.pageTimestamp || null,
						retrieval
					}
				})
			)
		);
	}
	return frames;
}

function isRetrievalTool(name: string): boolean {
	return name === 'web_extract' || name === 'verify_this_lead';
}

function browserSourceFrames(
	name: string,
	result: unknown,
	state: HermesNormalizationState,
	toolCallArguments = ''
): string[] {
	if (name !== 'browser_navigate' && name !== 'browser_snapshot') return [];
	const root = objectValue(parseMaybeJson(result));

	if (name === 'browser_navigate') {
		const args = objectValue(parseMaybeJson(toolCallArguments));
		const url = stringValue(root?.url) || stringValue(args?.url);
		if (url && /^https?:\/\//i.test(url)) {
			state.browserSource = { url, title: stringValue(root?.title) || url };
		}
	}
	if (!root || root.success === false || stringValue(root.error)) return [];
	const source = state.browserSource;
	const excerpt = compactExcerpt(root.snapshot ?? root.content);
	if (!source || !excerpt) return [];

	const domain = sourceDomain(source.url);
	return [
		sseFrame(
			'agent.source.read',
			JSON.stringify({
				source: {
					id: canonicalUrl(source.url),
					url: source.url,
					title: source.title,
					domain,
					status: 'read',
					detail: 'Hermes read this page with its browser.',
					verified: true,
					currentVerified: false,
					temporalScope: null,
					publishedAt: null,
					updatedAt: null,
					eventAt: null
				}
			})
		)
	];
}

function recordedSourceFrames(payload: Record<string, unknown>, state: HermesNormalizationState): string[] {
	const snapshot = objectValue(payload.snapshot);
	const sources = Array.isArray(snapshot?.newscraftSources) ? snapshot.newscraftSources : [];
	const frames: string[] = [];
	const citations: Array<Record<string, unknown>> = [];

	for (const raw of sources) {
		const source = objectValue(raw);
		const recordedUrl = stringValue(source?.url);
		const candidateRetrieval = recordedUrl
			? state.retrievalByUrl.get(canonicalUrl(recordedUrl))
			: undefined;
		// A state writer must not promote a candidate after Hermes rejected its
		// retrieval. Keep rejected and unreadable candidates out of citations.
		if (candidateRetrieval && candidateRetrieval.evidenceStatus !== 'accepted') continue;
		const retrieval = candidateRetrieval?.evidenceStatus === 'accepted' ? candidateRetrieval : undefined;
		const url = retrieval?.originalUrl || recordedUrl;
		const title = stringValue(source?.title);
		const excerpt = compactExcerpt(source?.supportingExcerpt ?? source?.supporting_excerpt);
		const citationNumber = integerValue(source?.citationNumber ?? source?.citation_number);
		if (!source || !url || !title || !excerpt || !citationNumber || !/^https?:\/\//i.test(url)) continue;

		const canonical = canonicalUrl(url);
		const numberOwner = state.citationUrls.get(citationNumber);
		const urlNumber = state.citationNumbers.get(canonical);
		if ((numberOwner && numberOwner !== canonical) || (urlNumber && urlNumber !== citationNumber)) continue;
		if (state.recordedSources.has(canonical)) continue;

		const assigned = assignCitationNumber(url, citationNumber, state);
		if (assigned !== citationNumber) continue;
		state.recordedSources.add(canonical);

		const domain = sourceDomain(url);
		const publicationDate =
			retrieval?.pageTimestamp || stringValue(source.publicationDate ?? source.publication_date) || null;
		const rawSourceType = stringValue(source.sourceType ?? source.source_type) || 'unknown';
		const sourceType = CITATION_SOURCE_TYPES.has(rawSourceType) ? rawSourceType : 'unknown';
		frames.push(
			sseFrame(
				'agent.source.read',
				JSON.stringify({
					source: {
						id: canonical,
						url,
						title,
						domain,
						status: 'read',
						detail: 'Hermes recorded this page after reading it.',
						verified: true,
						currentVerified: false,
						temporalScope: null,
						publishedAt: publicationDate,
						updatedAt: retrieval?.updatedAt || null,
						eventAt: retrieval?.pageTimestamp || null,
						retrieval
					}
				})
			)
		);
		citations.push({
			citationNumber,
			title,
			url,
			domain,
			publicationDate,
			sourceType,
			supportingExcerpt: excerpt,
			retrieval
		});
	}
	if (citations.length) frames.push(sseFrame('agent.citations', JSON.stringify({ citations })));
	return frames;
}

function compactToolResult(name: string, result: unknown): unknown {
	const parsed = parseMaybeJson(result);
	if (isRetrievalTool(name)) {
		const root = objectValue(parsed);
		const results = Array.isArray(root?.results)
			? root.results.flatMap((raw) => {
					const item = objectValue(raw);
					if (!item) return [];
					const retrieval = retrievalFromContent(item.content);
					return [
						{
							url: stringValue(item.url) || '',
							title: stringValue(item.title) || '',
							chars: compactExcerpt(item.content).length,
							originalUrl: retrieval?.originalUrl || stringValue(item.url) || null,
							retrievedUrl: retrieval?.retrievedUrl || null,
							evidenceStatus: retrieval?.evidenceStatus || null,
							rejectionReason: retrieval?.rejectionReason || stringValue(item.error) || null,
							retrievalMode: retrieval?.retrievalMode || null,
							archivedUrl: retrieval?.archivedUrl || null,
							captureTimestamp: retrieval?.captureTimestamp || null,
							pageTimestamp: retrieval?.pageTimestamp || null,
							retrievalTime: retrieval?.retrievalTime || null,
							fallbackReason: retrieval?.fallbackReason || null,
							requestCount: retrieval?.requestCount || null,
							error: stringValue(item.error) || null
						}
					];
			  })
			: [];
		return { results };
	}
	if (name.startsWith('browser_')) {
		const root = objectValue(parsed);
		if (!root) return parsed;
		return {
			success: root.success,
			url: stringValue(root.url),
			title: stringValue(root.title),
			snapshotChars: stringValue(root.snapshot)?.length || 0,
			elementCount: integerValue(root.element_count),
			error: stringValue(root.error)
		};
	}
	if (typeof result === 'string' && result.length > 24_000) return `${result.slice(0, 24_000)}\n[truncated]`;
	return parsed;
}

function normalizeAguiFrame(frame: RawSseFrame, state: HermesNormalizationState): string[] {
	if (frame.data === '[DONE]') return [sseFrame('message', '[DONE]')];
	const payload = objectValue(parseJson(frame.data));
	if (!payload) return [];
	const type = eventType(frame, payload);

	if (type === 'TEXT_MESSAGE_START') {
		state.currentTextMessageId = stringValue(payload.messageId ?? payload.message_id ?? payload.id) || randomUUID();
		state.currentText = '';
		return [];
	}
	if (type === 'TEXT_MESSAGE_CONTENT') {
		const delta = streamedString(payload.delta);
		if (delta) state.currentText += delta;
		return [];
	}
	if (type === 'TEXT_MESSAGE_END') {
		if (state.currentTextMessageId && state.currentText.trim()) {
			state.closedTextMessages.push({ id: state.currentTextMessageId, content: state.currentText });
		}
		state.currentTextMessageId = null;
		state.currentText = '';
		return [];
	}
	if (type === 'RUN_ERROR') {
		return [sseFrame('response.failed', JSON.stringify({ error: { message: errorMessage(payload) } }))];
	}
	if (type === 'RUN_FINISHED') {
		const outcome = objectValue(payload.outcome);
		if (outcome && stringValue(outcome.type) === 'interrupt') {
			return [
				sseFrame(
					'response.failed',
					JSON.stringify({ error: { message: 'Hermes paused for an unsupported interaction.' } })
				)
			];
		}
		const finalText = state.closedTextMessages.at(-1)?.content || state.currentText;
		return [
			...(finalText
				? [sseFrame('agent.answer.replace', JSON.stringify({ content: finalText }))]
				: []),
			sseFrame(
				'response.completed',
				JSON.stringify({ model: DEFAULT_MODEL, response: { output: [] } })
			)
		];
	}
	if (type === 'STATE_SNAPSHOT') return recordedSourceFrames(payload, state);

	if (type === 'TOOL_CALL_START') {
		const id = toolCallId(payload);
		if (!id) return [];
		const name = toolCallName(payload) || state.toolNames.get(id) || 'Hermes tool';
		state.toolNames.set(id, name);
		return [sseFrame('agent.tool.progress', JSON.stringify({ id, name, status: 'running' }))];
	}
	if (type === 'TOOL_CALL_ARGS') {
		const id = toolCallId(payload);
		if (!id) return [];
		const args = `${state.toolArguments.get(id) || ''}${streamedString(payload.delta) || ''}`;
		state.toolArguments.set(id, args);
		const name = toolCallName(payload) || state.toolNames.get(id) || 'Hermes tool';
		state.toolNames.set(id, name);
		return [sseFrame('agent.tool.progress', JSON.stringify({ id, name, arguments: args, status: 'running' }))];
	}
	if (type === 'TOOL_CALL_RESULT') {
		const id = toolCallId(payload);
		if (!id) return [];
		const name = toolCallName(payload) || state.toolNames.get(id) || 'Hermes tool';
		state.toolNames.set(id, name);
		const result = payload.result ?? payload.output ?? payload.content;
		const toolCallArguments = state.toolArguments.get(id) || '';
		return [
			sseFrame(
				'agent.tool.progress',
				JSON.stringify({ id, name, result: compactToolResult(name, result), status: 'ok' })
			),
				...(isRetrievalTool(name) ? extractedSourceFrames(result, state) : []),
			...browserSourceFrames(name, result, state, toolCallArguments)
		];
	}
	if (type === 'TOOL_CALL_END') {
		const id = toolCallId(payload);
		if (!id) return [];
		const name = toolCallName(payload) || state.toolNames.get(id) || 'Hermes tool';
		return [sseFrame('agent.tool.progress', JSON.stringify({ id, name, status: 'ok', done: true }))];
	}
	return [];
}

/** Convert Hermes AG-UI events to NewsCraft's existing internal stream contract. */
export function normalizeHermesSse(
	body: ReadableStream<Uint8Array>,
	seededCitations: SeededCitation[] = []
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let stopped = false;
	const state: HermesNormalizationState = {
		toolArguments: new Map(),
		toolNames: new Map(),
		citationNumbers: new Map(
			seededCitations.map((citation) => [canonicalUrl(citation.url), citation.citationNumber])
		),
		citationUrls: new Map(
			seededCitations.map((citation) => [citation.citationNumber, canonicalUrl(citation.url)])
		),
		recordedSources: new Set(seededCitations.map((citation) => canonicalUrl(citation.url))),
		browserSource: null,
		currentTextMessageId: null,
		currentText: '',
		closedTextMessages: [],
		retrievalByUrl: new Map(),
		nextCitationNumber: seededCitations.reduce(
			(maximum, citation) => Math.max(maximum, citation.citationNumber + 1),
			1
		)
	};

	function emitFrames(controller: ReadableStreamDefaultController<Uint8Array>, flush = false): void {
		if (flush) buffer += decoder.decode();
		while (true) {
			const boundary = buffer.match(/\r?\n\r?\n/);
			if (!boundary || boundary.index === undefined) break;
			const frameText = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary[0].length);
			const frame = parseSseFrame(frameText);
			if (!frame) continue;
			for (const output of normalizeAguiFrame(frame, state)) controller.enqueue(encoder.encode(output));
		}
		if (flush && buffer.trim()) {
			const frame = parseSseFrame(buffer);
			buffer = '';
			if (frame) {
				for (const output of normalizeAguiFrame(frame, state)) controller.enqueue(encoder.encode(output));
			}
		}
	}

	async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
		try {
			while (!stopped) {
				const result = await reader.read();
				if (stopped) return;
				if (result.done) {
					emitFrames(controller, true);
					stopped = true;
					controller.close();
					return;
				}
				buffer += decoder.decode(result.value, { stream: true });
				emitFrames(controller);
			}
		} catch (error) {
			if (!stopped) {
				stopped = true;
				controller.error(error);
			}
		}
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (seededCitations.length) {
				controller.enqueue(
					encoder.encode(sseFrame('agent.citations', JSON.stringify({ citations: seededCitations })))
				);
			}
			void pump(controller);
		},
		async cancel(reason) {
			stopped = true;
			await reader.cancel(reason);
		}
	});
}

export function describeGatewayError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message === 'fetch failed' || message === 'Failed to fetch' || message === 'Load failed') {
		return `Hermes is not reachable. Check NEWSCRAFT_HERMES_URL (${env.NEWSCRAFT_HERMES_URL || 'unset'}).`;
	}
	if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
		return 'Hermes did not respond in time.';
	}
	return message;
}

/** Legacy agent-job HTTP access is intentionally not available through Hermes chat. */
export async function agentFetch(_path: string, _init: RequestInit = {}): Promise<Response> {
	throw new Error('Legacy agent-job transport is disabled. NewsCraft uses Hermes chat only.');
}

export async function streamChatCompletion(
	body: AgentChatRequest,
	opts: HermesRequestOptions = {}
): Promise<Response> {
	if (!opts.accountId?.trim()) {
		throw new Error('Hermes requires an authenticated account scope.');
	}
	const sessionId = opts.sessionId ?? deriveSessionId(body.messages, opts.accountId);
	const traceId = traceHeader(opts.traceId) || randomUUID();
	const runId = randomUUID();
	const requireWebExtraction = opts.requireWebExtraction === true;
	const health = await gatewayHealth();
	if (!health.ok) {
		if (requireWebExtraction) throw webExtractionReadinessError(health);
		throw hermesIsolationReadinessError(health);
	}
	if (requireWebExtraction && !health.webExtractionReady) {
		throw webExtractionReadinessError(health);
	}
	const run = buildRunInput(
		body,
		sessionId,
		runId,
		opts.recordSources !== false,
		requireWebExtraction,
		[],
		traceId
	);
	const response = await fetch(`${hermesUrl()}/`, {
		method: 'POST',
		headers: { ...requestHeaders({ ...opts, traceId }), 'x-hermes-session-id': sessionId },
		body: JSON.stringify(run.input),
		signal: opts.signal
	});
	if (!response.ok || !response.body) return response;
	return new Response(normalizeHermesSse(response.body, run.seededCitations), {
		status: response.status,
		headers: { 'content-type': 'text/event-stream; charset=utf-8' }
	});
}

/** Build the authenticated Hermes input without opening a browser-owned stream. */
export function buildHermesRunInput(
	body: AgentChatRequest,
	threadId: string,
	runId: string,
	options: {
		recordSources?: boolean;
		webExtractConfigured?: boolean;
		seededCitations?: ReadonlyArray<CitationRecord>;
		traceId?: string;
	} = {}
): BuiltRunInput {
	return buildRunInput(
		body,
		threadId,
		runId,
		options.recordSources !== false,
		options.webExtractConfigured === true,
		options.seededCitations,
		options.traceId
	);
}

export interface DurableHermesRunStartRequest {
	runId: string;
	accountId: string;
	tenantKey: string;
	input: HermesRunInput;
	seededCitations: SeededCitation[];
	/** Required for new runs; absent only for legacy saved runs without a trace. */
	traceId?: string;
}

export class HermesDurableOverloadError extends Error {
	readonly code = 'overloaded';

	constructor() {
		super('Research service is temporarily at capacity. Try again shortly.');
		this.name = 'HermesDurableOverloadError';
	}
}

/** Start a durable worker owned by the NewsCraft Hermes service. */
export async function startDurableHermesRun(input: DurableHermesRunStartRequest): Promise<void> {
	const traceId = traceHeader(input.traceId);
	const inputTraceId = traceHeader(input.input.trace_id);
	if (input.input.trace_id !== undefined && (!inputTraceId || !traceId || inputTraceId !== traceId)) {
		throw new Error('Hermes durable trace binding does not match.');
	}
	const response = await fetch(`${hermesUrl()}/v1/runs/start`, {
		method: 'POST',
		headers: { ...requestHeaders({ accountId: input.accountId, traceId }), 'content-type': 'application/json' },
		body: JSON.stringify({
			run_id: input.runId,
			account_id: input.accountId,
			tenant_key: input.tenantKey,
			...(traceId ? { trace_id: traceId } : {}),
			input: input.input,
			seeded_citations: input.seededCitations
		})
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		let body: { code?: unknown; detail?: unknown } | null = null;
		try {
			body = JSON.parse(text) as { code?: unknown; detail?: unknown };
		} catch {
			/* Keep the existing generic transport error for non-JSON failures. */
		}
		if (response.status === 429 && body?.code === 'overloaded') {
			throw new HermesDurableOverloadError();
		}
		const detail = typeof body?.detail === 'string' ? body.detail : text;
		throw new Error(`Hermes durable start failed (${response.status}): ${detail || response.statusText}`);
	}
}

/** Request cancellation for the same durable Hermes run. */
export async function cancelDurableHermesRun(
	accountId: string,
	runId: string,
	traceId?: string
): Promise<{ state: string }> {
	const normalizedTraceId = traceHeader(traceId);
	const response = await fetch(`${hermesUrl()}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
		method: 'POST',
		headers: requestHeaders({ accountId, traceId: normalizedTraceId }),
		body: JSON.stringify({
			run_id: runId,
			account_id: accountId,
			tenant_key: deriveHermesTenantKey(accountId),
			...(normalizedTraceId ? { trace_id: normalizedTraceId } : {})
		})
	});
	if (!response.ok && response.status !== 404) {
		const detail = await response.text().catch(() => '');
		throw new Error(`Hermes durable cancel failed (${response.status}): ${detail || response.statusText}`);
	}
	if (response.status === 404) return { state: 'not_running' };
	const body = (await response.json().catch(() => null)) as { state?: unknown } | null;
	return { state: typeof body?.state === 'string' ? body.state : 'cancel_requested' };
}

function webExtractionReadinessError(health: GatewayHealth): Error {
	if (!health.status) {
		return new Error('NewsCraft Hermes readiness check did not respond.');
	}
	if (health.status !== 200 || !health.json) {
		return new Error(`NewsCraft Hermes readiness check failed (${health.status}).`);
	}
	const value = objectValue(health.json);
	const capabilities = objectValue(value?.capabilities);
	const extraction = objectValue(capabilities?.webExtraction);
	if (!extraction) {
		return new Error('NewsCraft web extraction is not configured on the Hermes service.');
	}
	if (extraction.configured !== true) {
		return new Error('NewsCraft web extraction is not ready on the Hermes service.');
	}
	return new Error(`NewsCraft Hermes readiness check failed (${health.status || 'unavailable'}).`);
}

function hermesIsolationReadinessError(health: GatewayHealth): Error {
	if (!health.status) {
		return new Error('NewsCraft Hermes readiness check did not respond.');
	}
	if (health.status !== 200 || !health.json) {
		return new Error(`NewsCraft Hermes readiness check failed (${health.status}).`);
	}
	return new Error('NewsCraft Hermes account isolation is not ready.');
}

/** Short side calls use the same Hermes run path. No second endpoint exists. */
export async function completion(
	body: AgentChatRequest,
	opts: HermesRequestOptions & { idempotencyKey?: string } = {}
): Promise<unknown> {
	const response = await streamChatCompletion(
		{ ...body, stream: true },
		{ ...opts, recordSources: false }
	);
	if (!response.ok || !response.body) throw new Error(`Hermes ${response.status}: ${await response.text()}`);
	const text = await new Response(response.body).text();
	let content = '';
	for (const rawFrame of text.split(/\r?\n\r?\n/)) {
		const frame = parseSseFrame(rawFrame);
		if (!frame || frame.data === '[DONE]') continue;
		const payload = objectValue(parseJson(frame.data));
		if (frame.event === 'response.output_text.delta') content += streamedString(payload?.delta) || '';
		if (frame.event === 'agent.answer.replace') content = streamedString(payload?.content) || content;
		if (frame.event === 'response.failed') {
			throw new Error(stringValue(objectValue(payload?.error)?.message) || 'Hermes returned an agent error.');
		}
	}
	if (!content.trim()) throw new Error('Hermes completed without a usable reply.');
	return {
		id: opts.idempotencyKey || `hermes-${Date.now()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: DEFAULT_MODEL,
		choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
	};
}

function emptyGatewayProviders(): GatewayHealth['providers'] {
	return {
		browser: null,
		webResearch: null,
		webExtraction: null,
		webLeadVerification: null
	};
}

function providerCapability(value: unknown, requiredFields: string[] = []): boolean | null {
	if (typeof value === 'boolean') return value;
	const object = objectValue(value);
	if (!object || typeof object.configured !== 'boolean') return null;
	return object.configured && requiredFields.every((field) => object[field] === true);
}

function combineCapabilitySignals(signals: Array<boolean | null>): boolean | null {
	if (signals.some((signal) => signal === false)) return false;
	return signals.every((signal) => signal === true) ? true : null;
}

function processInstanceId(value: unknown): string | null {
	return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

export async function gatewayHealth(): Promise<GatewayHealth> {
	const configuredUrl = (env.NEWSCRAFT_HERMES_URL || '').trim().replace(/\/$/, '');
	if (!configuredUrl) {
		return {
			ok: false,
			requiredReady: false,
			webExtractionReady: false,
			processInstanceId: null,
			providers: emptyGatewayProviders(),
			status: 0,
			body: 'Hermes is not configured. Set NEWSCRAFT_HERMES_URL.',
			json: null,
			service: SERVICE_NAME,
			url: ''
		};
	}
	const token = (env.NEWSCRAFT_HERMES_API_TOKEN || '').trim();
	if (!token) {
		return {
			ok: false,
			requiredReady: false,
			webExtractionReady: false,
			processInstanceId: null,
			providers: emptyGatewayProviders(),
			status: 0,
			body: 'Hermes authentication is not configured. Set NEWSCRAFT_HERMES_API_TOKEN.',
			json: null,
			service: SERVICE_NAME,
			url: configuredUrl
		};
	}
	try {
		const response = await fetch(`${configuredUrl}/ready`, {
			headers: { authorization: `Bearer ${token}`, 'x-hermes-session-token': token },
			signal: AbortSignal.timeout(2_000)
		});
		const body = await response.text();
		const parsed = parseJson(body);
		const value = objectValue(parsed);
		const tools = Array.isArray(value?.tools)
			? value.tools.filter((tool): tool is string => typeof tool === 'string')
			: [];
		const runtime = objectValue(value?.runtime);
		const capabilities = objectValue(value?.capabilities);
		const toolProviders = objectValue(value?.toolProviders);
		const webExtraction = objectValue(capabilities?.webExtraction);
		const webLeadVerification = objectValue(capabilities?.webLeadVerification);
		const accountIsolation = objectValue(capabilities?.accountIsolation);
		const requiredCapabilities = [
			'terminal',
			'files',
			'codeExecution',
			'delegation',
			'skills',
			'memory'
		];
		const durableRuns = objectValue(capabilities?.durableRuns);
		const reportedOk =
			value?.ok === true &&
			value.service === SERVICE_NAME &&
			value.toolset === HERMES_TOOLSET &&
			Boolean(stringValue(runtime?.provider)) &&
			Boolean(stringValue(runtime?.model)) &&
			runtime?.endpointMode === 'explicit' &&
			capabilities?.standard === true &&
			requiredCapabilities.every((name) => capabilities?.[name] === true) &&
			durableRuns?.configured === true &&
			durableRuns?.callback === true &&
			accountIsolation?.tenantHeader === 'x-newscraft-tenant-key' &&
			accountIsolation?.contextLocalHome === true &&
			accountIsolation?.stableTaskKey === true &&
			accountIsolation?.persistentDockerWorkspace === true &&
			accountIsolation?.isolatedBrowserProfiles === true;
		const providers = {
			browser: combineCapabilitySignals([
				providerCapability(toolProviders?.browser),
				providerCapability(capabilities?.browser),
				tools.includes('browser_navigate') && tools.includes('browser_snapshot')
			]),
			webResearch: combineCapabilitySignals([
				providerCapability(toolProviders?.webSearch),
				providerCapability(capabilities?.webResearch),
				tools.includes('web_search')
			]),
			webExtraction: combineCapabilitySignals([
				providerCapability(toolProviders?.webExtract),
				providerCapability(webExtraction, ['tool', 'leadVerificationTool']),
				tools.includes('web_extract')
			]),
			webLeadVerification: combineCapabilitySignals([
				providerCapability(toolProviders?.leadVerification),
				providerCapability(webLeadVerification, ['tool', 'bounded']),
				tools.includes('verify_this_lead')
			])
		};
		const webExtractionReady =
			providers.webExtraction === true && providers.webLeadVerification === true;
		const requiredReady = response.ok && reportedOk;
		return {
			ok: requiredReady,
			requiredReady,
			webExtractionReady,
			processInstanceId: processInstanceId(value?.processInstanceId),
			providers,
			status: response.status,
			body,
			json: parsed,
			service: stringValue(value?.service) || SERVICE_NAME,
			url: configuredUrl
		};
	} catch (error) {
		return {
			ok: false,
			requiredReady: false,
			webExtractionReady: false,
			processInstanceId: null,
			providers: emptyGatewayProviders(),
			status: 0,
			body: describeGatewayError(error),
			json: null,
			service: SERVICE_NAME,
			url: configuredUrl
		};
	}
}
