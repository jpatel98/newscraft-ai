export const HERMES_TOOLSET = 'hermes-acp';

export interface HermesContextEntry {
	description: string;
	value: string;
}

export interface HermesAguiMessage {
	id: string;
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<Record<string, unknown>>;
	toolCallId?: string;
	toolCalls?: Array<Record<string, unknown>>;
}

export interface HermesForwardedProps {
	source: 'newscraft';
	operation: 'chat';
	citationStartNumber: number;
	webExtractConfigured: boolean;
	retrievalVerificationTool: 'verify_this_lead';
	retrievalBackend: 'newscraft-local';
	retrievalMaxUrls: number;
	archiveFallback: 'wayback';
	stateWriterTools: HermesStateWriterTool[];
}

export interface HermesStateWriterTool {
	name: string;
	stateKey: string;
	arg: string;
	mode: 'append' | 'replace';
	description: string;
	parameters: Record<string, unknown>;
}

export interface HermesRunInput {
	threadId: string;
	runId: string;
	state: { newscraftSources: Array<Record<string, unknown>> };
	messages: HermesAguiMessage[];
	tools: [];
	context: HermesContextEntry[];
	forwardedProps: HermesForwardedProps;
}

export const HERMES_AGUI_EVENT_TYPES = {
	runStarted: 'RUN_STARTED',
	runFinished: 'RUN_FINISHED',
	runError: 'RUN_ERROR',
	textMessageStart: 'TEXT_MESSAGE_START',
	textMessageContent: 'TEXT_MESSAGE_CONTENT',
	textMessageEnd: 'TEXT_MESSAGE_END',
	toolCallStart: 'TOOL_CALL_START',
	toolCallArgs: 'TOOL_CALL_ARGS',
	toolCallEnd: 'TOOL_CALL_END',
	toolCallResult: 'TOOL_CALL_RESULT',
	stateSnapshot: 'STATE_SNAPSHOT'
} as const;
