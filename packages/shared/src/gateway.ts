export type ReasoningEffort = 'low' | 'medium' | 'high';

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
}
