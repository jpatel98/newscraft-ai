export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
	id: string;
	role: Role;
	content: string;
	partial: boolean;
}
