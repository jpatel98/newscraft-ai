export type ReasoningEffort = 'low' | 'medium' | 'high';

export type CitationSourceType =
	| 'official'
	| 'primary'
	| 'news_report'
	| 'social_post'
	| 'user_document'
	| 'commercial'
	| 'unknown';

export type ResearchEvidenceStatus =
	| 'discovery'
	| 'accepted'
	| 'rejected'
	| 'unreadable'
	| 'cited';

export type ResearchPageType =
	| 'article'
	| 'official_live'
	| 'hub'
	| 'document'
	| 'event_listing'
	| 'traffic_aggregator'
	| 'homepage'
	| 'category'
	| 'search'
	| 'forum'
	| 'social'
	| 'unknown';

export type ResearchPartialAnswerPolicy =
	| 'verified_subset'
	| 'verified_subset_with_leads'
	| 'must_meet_count';

export interface ResearchTemporalWindow {
	kind: 'current' | 'relative' | 'absolute' | 'unspecified';
	phrase?: string;
	start?: string;
	end?: string;
	timezone?: string;
	label?: string;
}

export type ResearchRequirementLevel =
	| 'local'
	| 'regional'
	| 'provincial'
	| 'national'
	| 'international'
	| 'global';

export type ResearchOutputType =
	| 'answer'
	| 'producer_roundup'
	| 'story_list'
	| 'comparison'
	| 'document_summary'
	| 'brief'
	| 'custom';

export type ResearchRequirementCompletionState =
	| 'pending'
	| 'executed'
	| 'partial'
	| 'satisfied'
	| 'incomplete'
	| 'skipped'
	| 'exhausted';

export interface ResearchRequirementCompletion {
	state: ResearchRequirementCompletionState;
	acceptedCount: number;
	requestedCount: number;
	gaps: string[];
	likelyToImprove: boolean;
	executedActions: number;
	skippedActions: number;
	exhausted: boolean;
}

/**
 * One independently answerable deliverable in the latest user turn. The
 * legacy contract fields below remain available for older gateways, while
 * new callers should use requirements as the authoritative request shape.
 */
export interface ResearchRequirement {
	id: string;
	label: string;
	subject: string;
	geography?: string;
	level?: ResearchRequirementLevel;
	requestedItemCount: number;
	countExplicit: boolean;
	temporalWindow: ResearchTemporalWindow;
	outputExpectations: string[];
	includedCategories: string[];
	excludedCategories: string[];
	excludedSourceTypes: string[];
	excludedPageTypes: ResearchPageType[];
	namedOutlets: string[];
	namedDomains: string[];
	referenceUrls: string[];
	completionState: ResearchRequirementCompletionState;
	completion?: ResearchRequirementCompletion;
}

/**
 * Provider-neutral control-plane state derived from the authoritative latest
 * user turn. It deliberately keeps editorial constraints out of a truncated
 * prose topic so every research provider and tool sees the same contract.
 */
export interface ResearchRequestContract {
	/** Version 1 remains valid for callers that do not send requirements. */
	version: 1 | 2;
	subject: string;
	location?: string;
	homeMarket?: string;
	temporalWindow: ResearchTemporalWindow;
	requestedItemCount?: number;
	includedDesks: string[];
	includedCategories: string[];
	excludedDesks: string[];
	excludedCategories: string[];
	excludedSourceTypes: string[];
	excludedPageTypes: ResearchPageType[];
	namedOutlets: string[];
	namedDomains: string[];
	requiredOutputFields: string[];
	partialAnswerPolicy: ResearchPartialAnswerPolicy;
	allowFewerThanRequested: boolean;
	referenceUrls: string[];
	/** Optional for backwards-compatible v1 contracts; normalized runs always populate it. */
	requirements?: ResearchRequirement[];
	outputType?: ResearchOutputType;
}

export interface ResearchSourceProfile {
	majorPublisherDomains?: string[];
	officialSourceDomains?: string[];
	relevantDesks?: string[];
}

export interface ConversationResearchLead {
	url: string;
	title: string;
	domain: string;
	status: ResearchEvidenceStatus | string;
	used: boolean;
	detail?: string;
	publicationDate?: string | null;
}

export interface CitationRecord {
	citationNumber: number;
	title: string;
	url: string;
	domain: string;
	publicationDate: string | null;
	sourceType: CitationSourceType;
	supportingExcerpt: string;
	documentPage?: number;
}

export interface NewsroomContext {
	timezone: string;
	homeMarket?: string;
	preferredDomains?: string[];
	sourceProfile?: ResearchSourceProfile;
}

export type ConversationIntent = 'research' | 'verify' | 'correct' | 'transform';

export interface ConversationTopic {
	/** Human-readable subject carried across follow-ups. */
	subject: string;
	entities?: string[];
	location?: string;
	/** Calendar date or date phrase relevant to the claim, not a retrieval timestamp. */
	relevantDate?: string;
	/** Named publishers that the user explicitly asked to compare or verify directly. */
	requestedOutlets?: string[];
	/** True when republished copies cannot satisfy the requested outlet evidence. */
	directSourcesRequired?: boolean;
}

export interface ConversationClaimState {
	text: string;
	status: 'disputed' | 'corrected' | 'retracted';
	correction?: string;
	messageId?: string;
}

export interface ConversationSourceAnswer {
	messageId: string;
	content: string;
	citations: CitationRecord[];
	/** Bounded direct-source leads retained even when they were not cited. */
	leads?: ConversationResearchLead[];
	publicationDates?: string[];
}

export type ConversationOperation = 'send' | 'retry' | 'resume' | 'regenerate' | 'transform';

export interface ConversationCurrentTurn {
	/** Durable user-message id when the request already exists in app storage. */
	messageId?: string;
	/** The user's literal, authoritative instruction for this run. */
	content: string;
	/** Concrete task to execute now. Normally identical to the authoritative instruction. */
	resolvedRequest: string;
	operation: ConversationOperation;
	/** Routes this turn directly through research before synthesis. */
	researchRequired: boolean;
	/** Current/latest results must be ordered newest-first and pass freshness checks. */
	freshness?: 'current';
	/** Structured control-plane contract for this authoritative latest turn. */
	researchContract?: ResearchRequestContract;
}

export interface ConversationRecentTurn {
	messageId: string;
	role: 'user' | 'assistant';
	content: string;
}

/**
 * Provider-independent, conversation-scoped working state. The app rebuilds
 * this bounded packet from durable messages and provenance for every request;
 * the harness remains stateless.
 */
export interface ConversationContext {
	version: 1;
	intent: ConversationIntent;
	currentTurn?: ConversationCurrentTurn;
	recentTurns?: ConversationRecentTurn[];
	activeTopic?: ConversationTopic;
	targetMessageId?: string;
	sourceMessageId?: string;
	lastSourceBackedAnswer?: ConversationSourceAnswer;
	claimStates?: ConversationClaimState[];
	unresolvedQuestions?: string[];
}

export interface DocumentContextPage {
	pageNumber: number;
	text: string;
}

export interface DocumentContext {
	id: string;
	filename: string;
	downloadUrl?: string;
	checksum?: string;
	pageCount: number;
	pages: DocumentContextPage[];
}

export type GatewayContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export type GatewayContent = string | GatewayContentPart[];

export type GatewayChatMessage =
	| { role: 'system' | 'user' | 'assistant'; content: GatewayContent }
	| { role: 'tool'; content: string; tool_call_id?: string };

export interface GatewayChatCompletionRequest {
	messages: GatewayChatMessage[];
	model?: string;
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	reasoning_effort?: ReasoningEffort;
	/** Diagnostics/eval override: false forces the regex-router fallback for this request. */
	planner_enabled?: boolean;
	/** Correlation id propagated from the app request for observability/log joins. */
	trace_id?: string;
	/** Organization-scoped editorial defaults, kept separate from the user prompt. */
	newsroom_context?: NewsroomContext;
	/** Bounded conversation state rebuilt by the durable app owner. */
	conversation_context?: ConversationContext;
	/** Bounded page excerpts from private conversation documents. */
	documents?: DocumentContext[];
}

export interface GatewayChatCompletionChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: { role?: 'assistant'; content?: string };
		finish_reason: string | null;
	}>;
}

export interface GatewayChatCompletionResponse {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: { role: 'assistant'; content: string };
		finish_reason: string;
	}>;
}

export type GatewayResponseContentPart =
	| { type: 'input_text'; text: string }
	| { type: 'input_image'; image_url: string };

export interface GatewayResponseInputMessage {
	role: 'user' | 'assistant' | 'system';
	content: string | GatewayResponseContentPart[];
}

export interface GatewayResponsesRequest {
	input: string | GatewayResponseInputMessage[];
	model?: string;
	instructions?: string;
	reasoning_effort?: ReasoningEffort;
	stream?: boolean;
	store?: boolean;
	conversation?: string;
	previous_response_id?: string;
	/** Correlation id propagated from the app request for observability/log joins. */
	trace_id?: string;
	/** Organization-scoped editorial defaults, kept separate from the user prompt. */
	newsroom_context?: NewsroomContext;
	/** Bounded conversation state rebuilt by the durable app owner. */
	conversation_context?: ConversationContext;
	/** Bounded page excerpts from private conversation documents. */
	documents?: DocumentContext[];
}
