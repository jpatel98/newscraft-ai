export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface TextPart {
	type: 'text';
	text: string;
}
export interface ImageUrlPart {
	type: 'image_url';
	image_url: { url: string };
}
export type ContentPart = TextPart | ImageUrlPart;

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
	id: string;
	role: Role;
	content: MessageContent;
	partial: boolean;
	/** True only for the message currently being streamed in the live overlay.
	 * Persisted partial messages have partial=1 but streaming=false. */
	streaming?: boolean;
}

/** Plain-text projection of a message for callers that don't render parts (copy, recall, etc.). */
export function contentText(c: MessageContent): string {
	if (typeof c === 'string') return c;
	return c
		.filter((p): p is TextPart => p.type === 'text')
		.map((p) => p.text)
		.join('\n')
		.trim();
}

/** Tally non-text parts so call sites can branch on "has images". */
export function hasImageParts(c: MessageContent): boolean {
	return Array.isArray(c) && c.some((p) => p.type === 'image_url');
}
