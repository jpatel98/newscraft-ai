import type {
	CitationRecord,
	ConversationClaimState,
	ConversationContext,
	ConversationIntent,
	ConversationSourceAnswer,
	ConversationTopic
} from '@newscraft/shared';
import type { MessageRow } from '$lib/server/db/conversations';
import type { MessageProvenanceRow } from '$lib/server/db/message-provenance';
import { contentText } from '$lib/types';
import { parseContent } from '$lib/server/db/conversations';
import {
	citationNumbersInText,
	isInspectableCitationRecord,
	parseToolMetadata
} from '$lib/utils/tool-metadata';

const MAX_CONTEXT_BYTES = 24 * 1024;
const MAX_TOPIC_CHARS = 480;
const MAX_ANSWER_CHARS = 6200;
const MAX_CITATIONS = 12;
const MAX_CITATION_EXCERPT_CHARS = 520;
const MAX_CLAIM_STATES = 8;
const MAX_UNRESOLVED = 6;
const MAX_RECENT_PROVENANCE_MESSAGES = 12;
const COMPATIBILITY_CONTEXT_TAG = '[NewsCraft compatibility conversation context]';

const ENTITY_STOP_WORDS = new Set([
	'What',
	'When',
	'Where',
	'Who',
	'Why',
	'How',
	'The',
	'This',
	'That',
	'These',
	'Those',
	'Can',
	'Could',
	'Would',
	'Please',
	'Today',
	'Yesterday',
	'Current',
	'Latest',
	'NewsCraft',
	'Create',
	'Write',
	'Turn',
	'Draft',
	'Compare',
	'Check',
	'Verify',
	'Summarize',
	'Official',
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
]);

const PUBLISHER_ALIASES: Array<[string, RegExp]> = [
	['CBC', /\bCBC(?:\s+News)?\b/i],
	['Global News', /\bGlobal(?:\s+News)?\b/i],
	['CTV News', /\bCTV(?:\s+News)?\b/i],
	['CityNews', /\bCityNews\b/i],
	['Reuters', /\bReuters\b/i],
	['Associated Press', /\b(?:Associated Press|AP News)\b/i],
	['BBC', /\bBBC(?:\s+News)?\b/i],
	['Guardian', /\b(?:The\s+)?Guardian\b/i],
	['FIFA', /\bFIFA\b/i],
	['ECCC', /\b(?:ECCC|Environment and Climate Change Canada)\b/i],
	['TTC', /\b(?:TTC|Toronto Transit Commission)\b/i]
];

const COMMON_LOCATION_NAMES = [
	'Toronto',
	'Ontario',
	'Canada',
	'Ottawa',
	'Montreal',
	'Quebec',
	'Vancouver',
	'Calgary',
	'Edmonton',
	'Winnipeg',
	'Halifax',
	'Hamilton',
	'Mississauga',
	'Brampton',
	'Northern Ontario',
	'Los Angeles',
	'Santo Domingo'
];

const PUBLISHER_COMPARISON_PATTERNS = [
	/\bcompare(?:\s+same[- ]day)?\s+(.{2,80}?)\s+(?:and|with|vs\.?|versus)\s+(.{2,80}?)\s+(?:coverage|reporting|articles?|reports?)\b/i,
	/\b(?:coverage|reporting|articles?|reports?)\s+(?:from|by)\s+(.{2,80}?)\s+(?:and|with|vs\.?|versus)\s+(.{2,80}?)(?=\s+(?:about|on|of|for|in)\b|[.?!,]|$)/i
];

export interface BuildConversationContextInput {
	messages: MessageRow[];
	provenance?: MessageProvenanceRow[];
	currentRequest: string;
	outputAction?: boolean;
	sourceMessageId?: string;
}

export function conversationContextProvenanceMessageIds(input: {
	messages: MessageRow[];
	sourceMessageId?: string;
}): string[] {
	const ids = new Set<string>();
	if (input.sourceMessageId) ids.add(input.sourceMessageId);
	let recentAssistantCount = 0;
	for (let index = input.messages.length - 1; index >= 0; index -= 1) {
		const message = input.messages[index];
		if (message?.role !== 'assistant' || message.partial === 1) continue;
		ids.add(message.id);
		recentAssistantCount += 1;
		if (recentAssistantCount >= MAX_RECENT_PROVENANCE_MESSAGES) break;
	}
	return Array.from(ids);
}

export function buildConversationContext(input: BuildConversationContextInput): ConversationContext {
	const currentRequest = compact(input.currentRequest, MAX_TOPIC_CHARS);
	const intent = conversationIntent(currentRequest, Boolean(input.outputAction));
	const provenanceByMessage = new Map(
		(input.provenance ?? []).map((row) => [row.messageId, citationsFromProvenance(row.provenanceJson)])
	);
	const inheritsPriorState =
		Boolean(input.sourceMessageId) || referencesPriorConversation(currentRequest, intent);
	const selectedSource = inheritsPriorState
		? findSourceAnswer(input.messages, provenanceByMessage, input.sourceMessageId) ??
			findSourceAnswer(input.messages, provenanceByMessage)
		: undefined;
	const topicPrompt = inheritsPriorState
		? topicPromptFor(input.messages, selectedSource?.messageId, currentRequest)
		: currentRequest;
	const context: ConversationContext = {
		version: 1,
		intent,
		...(topicPrompt ? { activeTopic: buildTopic(topicPrompt, selectedSource?.citations ?? [], currentRequest) } : {}),
		...(input.sourceMessageId ? { targetMessageId: input.sourceMessageId, sourceMessageId: input.sourceMessageId } : {}),
		...(selectedSource ? { lastSourceBackedAnswer: selectedSource } : {}),
		...(inheritsPriorState ? claimStateFields(input.messages) : {}),
		...(inheritsPriorState ? unresolvedFields(input.messages) : {})
	};
	return fitContextToBudget(context);
}

export function conversationContextCompatibilityMessage(context: ConversationContext): string {
	const topic = context.activeTopic;
	const source = context.lastSourceBackedAnswer;
	const lines = [
		COMPATIBILITY_CONTEXT_TAG,
		'This is a compatibility fallback for conversation-scoped state. The current user request remains authoritative.',
		`Intent: ${context.intent}.`,
		...(topic
			? [
					`Active subject: ${topic.subject}`,
					...(topic.entities?.length ? [`Relevant entities: ${topic.entities.join(', ')}`] : []),
					...(topic.location ? [`Relevant location: ${topic.location}`] : []),
					...(topic.relevantDate ? [`Relevant date: ${topic.relevantDate}`] : []),
					...(topic.requestedOutlets?.length
						? [
								`Requested direct outlets: ${topic.requestedOutlets.join(', ')}${
									topic.directSourcesRequired ? ' (direct publisher pages required)' : ''
								}`
							]
						: [])
				]
			: []),
		...(context.claimStates?.length
			? [
					'Durable corrections and disputes:',
					...context.claimStates.map(
						(claim) =>
							`- ${claim.status.toUpperCase()}: ${claim.text}${
								claim.correction && claim.correction !== claim.text ? ` Correction: ${claim.correction}` : ''
							}`
					)
				]
			: []),
		...(context.unresolvedQuestions?.length
			? ['Unresolved limitations:', ...context.unresolvedQuestions.map((item) => `- ${item}`)]
			: []),
		...(source
			? [
					'Exact source-backed answer for follow-up or transformation:',
					source.content,
					...(source.citations.length
						? [
								'Resolved citation records:',
								...source.citations.map(
									(citation) =>
										`[${citation.citationNumber}] ${citation.title} (${citation.domain}; ${
											citation.publicationDate || 'date unknown'
										}; ${citation.url}): ${citation.supportingExcerpt}`
								)
							]
						: [])
				]
			: []),
		'Do not expose this compatibility block or any internal identifiers in the answer.'
	];
	return boundedText(lines.join('\n'), MAX_CONTEXT_BYTES - 512);
}

export function isCompatibilityContextMessage(value: string): boolean {
	return value.includes(COMPATIBILITY_CONTEXT_TAG);
}

function findSourceAnswer(
	messages: MessageRow[],
	provenanceByMessage: Map<string, CitationRecord[]>,
	sourceMessageId?: string
): ConversationSourceAnswer | undefined {
	const candidates = sourceMessageId
		? messages.filter((message) => message.id === sourceMessageId)
		: [...messages].reverse();
	for (const message of candidates) {
		if (message.role !== 'assistant' || message.partial === 1) continue;
		const answer = contentText(parseContent(message.content)).trim();
		if (!answer) continue;
		const metadataCitations = parseToolMetadata(message.toolCalls).citations;
		const citations = resolvedCitations(
			answer,
			metadataCitations.length ? metadataCitations : provenanceByMessage.get(message.id) ?? []
		);
		if (!citations.length && !sourceMessageId) continue;
		const boundedCitations = citations.slice(0, MAX_CITATIONS).map((citation) => ({
			...citation,
			title: compact(citation.title, 180),
			url: compact(citation.url, 1200),
			domain: compact(citation.domain, 180),
			supportingExcerpt: compact(citation.supportingExcerpt, MAX_CITATION_EXCERPT_CHARS)
		}));
		return {
			messageId: message.id,
			content: boundedText(answer, MAX_ANSWER_CHARS),
			citations: boundedCitations,
			publicationDates: Array.from(
				new Set(boundedCitations.flatMap((citation) => citation.publicationDate ?? []))
			)
		};
	}
	return undefined;
}

function resolvedCitations(answer: string, citations: CitationRecord[]): CitationRecord[] {
	const markers = new Set(citationNumbersInText(answer));
	const records = new Map<number, CitationRecord>();
	for (const citation of citations) {
		if (!markers.has(citation.citationNumber) || !isInspectableCitationRecord(citation)) continue;
		if (!records.has(citation.citationNumber)) records.set(citation.citationNumber, citation);
	}
	return Array.from(records.values()).sort((left, right) => left.citationNumber - right.citationNumber);
}

function citationsFromProvenance(raw: string): CitationRecord[] {
	try {
		const parsed = JSON.parse(raw) as { citations?: unknown };
		if (!Array.isArray(parsed.citations)) return [];
		return parsed.citations.filter(isCitationRecord);
	} catch {
		return [];
	}
}

function isCitationRecord(value: unknown): value is CitationRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Partial<CitationRecord>;
	return (
		typeof record.citationNumber === 'number' &&
		typeof record.title === 'string' &&
		typeof record.url === 'string' &&
		typeof record.domain === 'string' &&
		typeof record.supportingExcerpt === 'string'
	);
}

function topicPromptFor(
	messages: MessageRow[],
	sourceMessageId: string | undefined,
	currentRequest: string
): string {
	if (sourceMessageId) {
		const sourceIndex = messages.findIndex((message) => message.id === sourceMessageId);
		for (let index = sourceIndex - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== 'user') continue;
			const value = contentText(parseContent(message.content)).trim();
			if (value && !looksLikeAmbiguousFollowup(value) && topicSpecificity(value) >= 2) {
				return compact(topicWithCurrentQualifier(value, currentRequest), MAX_TOPIC_CHARS);
			}
		}
	}
	if (!looksLikeAmbiguousFollowup(currentRequest)) return currentRequest;
	let fallback = '';
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== 'user') continue;
		const value = contentText(parseContent(message.content)).trim();
		if (!value || looksLikeAmbiguousFollowup(value)) continue;
		fallback ||= value;
		if (topicSpecificity(value) >= 2) return compact(topicWithCurrentQualifier(value, currentRequest), MAX_TOPIC_CHARS);
	}
	return compact(fallback ? topicWithCurrentQualifier(fallback, currentRequest) : currentRequest, MAX_TOPIC_CHARS);
}

function topicSpecificity(value: string): number {
	let score = 0;
	if (extractLocation(value)) score += 4;
	if (extractRequestedOutlets(value).length) score += 3;
	if (extractRelevantDate(value)) score += 2;
	if (extractEntities(value).length) score += 1;
	return score;
}

function buildTopic(
	subject: string,
	citations: CitationRecord[],
	currentRequest: string = subject
): ConversationTopic {
	const extractionText = `${subject}\n${currentRequest}`;
	const requestedOutlets = extractRequestedOutlets(extractionText);
	const publicationDates = citations
		.map((citation) => citation.publicationDate)
		.filter((value): value is string => Boolean(value));
	const relevantDate = extractRelevantDate(currentRequest) ?? extractRelevantDate(subject) ?? publicationDates[0];
	const entities = extractEntities(extractionText);
	const location = extractLocation(extractionText);
	const comparison = /\b(compare|comparison|versus|vs\.?|both|two outlets?|coverage)\b/i.test(extractionText);
	return {
		subject,
		...(entities.length ? { entities } : {}),
		...(location ? { location } : {}),
		...(relevantDate ? { relevantDate } : {}),
		...(requestedOutlets.length ? { requestedOutlets } : {}),
		...(comparison && requestedOutlets.length > 1 ? { directSourcesRequired: true } : {})
	};
}

function extractEntities(value: string): string[] {
	const entities = new Set<string>();
	for (const match of value.matchAll(/[""]([^""]{2,80})[""]/g)) {
		const entity = cleanEntityCandidate(match[1]);
		if (entity) entities.add(entity);
	}
	for (const match of value.matchAll(/\b(?:[A-Z]{2,}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g)) {
		const entity = cleanEntityCandidate(match[0]);
		if (entity) entities.add(entity);
	}
	for (const [name, pattern] of PUBLISHER_ALIASES) {
		if (pattern.test(value)) entities.add(name);
	}
	return Array.from(entities).slice(0, 10);
}

function cleanEntityCandidate(value: string): string {
	const words = value.trim().split(/\s+/);
	while (words.length && ENTITY_STOP_WORDS.has(words[0])) words.shift();
	while (words.length && ENTITY_STOP_WORDS.has(words.at(-1) ?? '')) words.pop();
	const entity = words.join(' ').trim();
	return entity.length > 2 ? entity : '';
}

function extractRequestedOutlets(value: string): string[] {
	const outlets = new Set<string>();
	for (const [name, pattern] of PUBLISHER_ALIASES) {
		if (pattern.test(value)) outlets.add(name);
	}
	for (const pattern of PUBLISHER_COMPARISON_PATTERNS) {
		const match = value.match(pattern);
		if (!match) continue;
		for (const candidate of match.slice(1, 3)) {
			const outlet = normalizePublisherCandidate(candidate);
			if (outlet) outlets.add(outlet);
		}
	}
	return Array.from(outlets).slice(0, 6);
}

function normalizePublisherCandidate(value: string): string {
	const cleaned = value.replace(/^(?:the|an?|same[- ]day)\s+/i, '').trim();
	if (!cleaned || cleaned.length > 60) return '';
	const words = cleaned.split(/\s+/);
	if (words.length > 6 || /\b(?:story|topic|announcement|event|claim)\b/i.test(cleaned)) return '';
	return cleaned;
}

function extractLocation(value: string): string | undefined {
	for (const match of value.matchAll(
		/\b(?:in|near|across|around|within|outside|for)\s+([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3})(?=\s+(?:on|today|yesterday|this|about|after|before|from|using|with)\b|[,.?!]|$)/gu
	)) {
		const candidate = cleanEntityCandidate(match[1]);
		if (candidate && !/\b(?:article|coverage|report|source|answer)\b/i.test(candidate)) return candidate;
	}
	return COMMON_LOCATION_NAMES.find((place) =>
		new RegExp(`\\b${place.replace(/\s+/g, '\\s+')}\\b`, 'i').test(value)
	);
}

function extractRelevantDate(value: string): string | undefined {
	return (
		value.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0] ??
		value.match(
			/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*20\d{2})?\b/i
		)?.[0] ??
		value.match(/\b(?:today|yesterday|current|latest|now)\b/i)?.[0].toLowerCase()
	);
}

function conversationIntent(value: string, outputAction: boolean): ConversationIntent {
	if (outputAction || /\b(transform|rewrite|turn .* into|producer brief|OC\/VO|script|interview questions)\b/i.test(value)) {
		return 'transform';
	}
	if (/\b(correct|correction|retract|wrong|incorrect|not active|no longer active)\b/i.test(value)) return 'correct';
	if (/\b(verify|fact[- ]?check|confirm|is (?:this|that|it) true|challenge)\b/i.test(value)) return 'verify';
	return 'research';
}

function referencesPriorConversation(value: string, intent: ConversationIntent): boolean {
	if (intent === 'transform') return true;
	const normalized = value.replace(/\s+/g, ' ').trim();
	if (looksLikeExplicitNewTopicRequest(normalized)) return false;
	if (looksLikeAmbiguousFollowup(value)) return true;
	if (normalized.length > 240) return false;
	return (
		/\b(?:previous|earlier|above|same|cited page|official page|source page|the answer|the claim|the alert|the status)\b/i.test(
			normalized
		) ||
		/^(?:keep|rewrite|shorten|expand|summarize|explain|cite|list|show|give|tell me more)\b/i.test(
			normalized
		) ||
		/\b(?:the|those|that|this)\s+(?:sources?|citations?|links?)\b/i.test(normalized) ||
		/^is there (?:an?|any) (?:update|change)\b/i.test(normalized)
	);
}

function claimStateFields(messages: MessageRow[]): Pick<ConversationContext, 'claimStates'> {
	const states: ConversationClaimState[] = [];
	for (const message of messages) {
		if (message.role !== 'user' && message.role !== 'assistant') continue;
		const text = compact(contentText(parseContent(message.content)), 420);
		if (!text || !/\b(dispute|challenge|correct|correction|retract|wrong|incorrect|unsupported|not active|no longer active|could not verify|couldn't verify)\b/i.test(text)) {
			continue;
		}
		const status: ConversationClaimState['status'] =
			/\b(retract|unsupported|not active|no longer active|could not verify|couldn't verify)\b/i.test(text)
				? 'retracted'
				: /\b(correct|correction|wrong|incorrect)\b/i.test(text)
					? 'corrected'
					: 'disputed';
		states.push({
			text,
			status,
			...(status === 'corrected' || status === 'retracted' ? { correction: text } : {}),
			messageId: message.id
		});
	}
	return states.length ? { claimStates: states.slice(-MAX_CLAIM_STATES) } : {};
}

function unresolvedFields(messages: MessageRow[]): Pick<ConversationContext, 'unresolvedQuestions'> {
	const unresolved: string[] = [];
	for (const message of messages) {
		if (message.role !== 'assistant') continue;
		const text = contentText(parseContent(message.content));
		for (const sentence of text.split(/(?<=[.!?])\s+/)) {
			if (
				/\b(could not|couldn't|unable to|not available|not found|unverified|unclear|unknown|no reliable|no direct|insufficient)\b/i.test(
					sentence
				)
			) {
				const compacted = compact(sentence, 320);
				if (compacted && !unresolved.includes(compacted)) unresolved.push(compacted);
			}
		}
	}
	return unresolved.length ? { unresolvedQuestions: unresolved.slice(-MAX_UNRESOLVED) } : {};
}

function looksLikeAmbiguousFollowup(value: string): boolean {
	const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
	return (
		normalized.length < 90 &&
		(/\b(it|this|that|they|he|she|the claim|the alert|same topic|previous answer)\b/.test(normalized) ||
			/^(and|but|so|what about|is it|are they|does that|what did)\b/.test(normalized))
	);
}

function topicWithCurrentQualifier(subject: string, currentRequest: string): string {
	if (!currentRequest || !hasAuthoritativeCurrentQualifier(currentRequest)) return subject;
	if (normalizedComparable(subject).includes(normalizedComparable(currentRequest))) return subject;
	return `${subject} Current follow-up: ${currentRequest}`;
}

function hasAuthoritativeCurrentQualifier(value: string): boolean {
	return Boolean(
		extractRelevantDate(value) ||
			/\b(?:still active|active today|active now|currently active|right now|as of)\b/i.test(value)
	);
}

function looksLikeExplicitNewTopicRequest(value: string): boolean {
	const normalized = value.toLowerCase();
	if (!normalized) return false;
	const patterns = [
		/^(?:find|search|look up|research|gather|collect|get)\b[\s\S]{0,80}\b(?:sources?|citations?|links?)\b[\s\S]{0,40}\b(?:on|for|about)\s+(.{3,})$/i,
		/^(?:find|search|look up|research|gather|collect|get)\b[\s\S]{0,80}\b(?:on|for|about)\s+(.{3,})$/i,
		/\b(?:sources?|citations?|links?)\s+(?:on|for|about)\s+(.{3,})$/i
	];
	for (const pattern of patterns) {
		const topic = value.match(pattern)?.[1] ?? '';
		if (hasExplicitTopicTail(topic)) return true;
	}
	return false;
}

function hasExplicitTopicTail(value: string): boolean {
	const normalized = value.toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '').trim();
	if (!normalized) return false;
	if (
		/^(?:it|this|that|these|those|same|previous|above|the (?:answer|story|claim|alert|status|source|citation|link))$/i.test(
			normalized
		)
	) {
		return false;
	}
	const topicWords = normalized
		.replace(/^(?:this|that|the|a|an)\s+/, '')
		.split(/\W+/)
		.filter((word) => word.length >= 3 && !['source', 'sources', 'citation', 'citations', 'links'].includes(word));
	return topicWords.length > 0;
}

function normalizedComparable(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function fitContextToBudget(context: ConversationContext): ConversationContext {
	if (byteLength(context) <= MAX_CONTEXT_BYTES) return context;
	const reduced: ConversationContext = {
		...context,
		claimStates: context.claimStates?.slice(-4),
		unresolvedQuestions: context.unresolvedQuestions?.slice(-3),
		lastSourceBackedAnswer: context.lastSourceBackedAnswer
			? {
					...context.lastSourceBackedAnswer,
					content: boundedText(context.lastSourceBackedAnswer.content, 3600),
					citations: context.lastSourceBackedAnswer.citations.slice(0, 8).map((citation) => ({
						...citation,
						supportingExcerpt: compact(citation.supportingExcerpt, 300)
					}))
				}
			: undefined
	};
	while (
		byteLength(reduced) > MAX_CONTEXT_BYTES &&
		(reduced.lastSourceBackedAnswer?.citations.length ?? 0) > 1
	) {
		reduced.lastSourceBackedAnswer?.citations.pop();
	}
	while (byteLength(reduced) > MAX_CONTEXT_BYTES && (reduced.claimStates?.length ?? 0) > 1) {
		reduced.claimStates?.shift();
	}
	while (byteLength(reduced) > MAX_CONTEXT_BYTES && (reduced.unresolvedQuestions?.length ?? 0) > 1) {
		reduced.unresolvedQuestions?.shift();
	}
	if (byteLength(reduced) > MAX_CONTEXT_BYTES && reduced.lastSourceBackedAnswer) {
		reduced.lastSourceBackedAnswer.content = boundedText(
			reduced.lastSourceBackedAnswer.content,
			1600
		);
	}
	return reduced;
}

function byteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function compact(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function boundedText(value: string, maxLength: number): string {
	const cleaned = value.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
