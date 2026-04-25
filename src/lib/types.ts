export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
	id: string;
	role: Role;
	content: string;
	partial: boolean;
	/** True only for the message currently being streamed in the live overlay.
	 * Persisted partial messages have partial=1 but streaming=false. */
	streaming?: boolean;
}
