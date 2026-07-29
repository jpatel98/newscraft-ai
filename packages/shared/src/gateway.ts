export type ReasoningEffort = 'low' | 'medium' | 'high';

export type CitationSourceType =
	| 'official'
	| 'primary'
	| 'news_report'
	| 'social_post'
	| 'user_document'
	| 'commercial'
	| 'unknown';

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
