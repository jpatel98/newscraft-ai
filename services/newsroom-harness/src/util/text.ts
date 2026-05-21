import type {
	GatewayChatMessage,
	GatewayContent,
	GatewayResponseInputMessage
} from '@newscraft/shared';

function contentText(content: GatewayContent | string | undefined): string {
	if (!content) return '';
	if (typeof content === 'string') return content;
	return content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
		.trim();
}

export function promptFromChatMessages(messages: GatewayChatMessage[]): string {
	return messages
		.map((message) => {
			const label = message.role === 'tool' ? 'tool' : message.role;
			return `${label}: ${contentText(message.content)}`;
		})
		.filter((line) => !line.endsWith(': '))
		.join('\n\n');
}

export function promptFromResponseInput(
	input: string | GatewayResponseInputMessage[],
	instructions?: string
): string {
	if (typeof input === 'string') return [instructions, input].filter(Boolean).join('\n\n');
	return [
		instructions,
		...input.map((item) => {
			const text =
				typeof item.content === 'string'
					? item.content
					: item.content
							.filter((part) => part.type === 'input_text')
							.map((part) => part.text)
							.join('\n');
			return `${item.role}: ${text}`;
		})
	]
		.filter(Boolean)
		.join('\n\n');
}

export function splitForStreaming(text: string, targetChunkSize = 42): string[] {
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > targetChunkSize) {
		const idx = Math.max(
			remaining.lastIndexOf(' ', targetChunkSize),
			remaining.lastIndexOf('\n', targetChunkSize)
		);
		const cut = idx > 12 ? idx + 1 : targetChunkSize;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export function firstUrl(text: string): string | null {
	return text.match(/https?:\/\/[^\s)>\]]+/i)?.[0] ?? null;
}

export function extractUrls(text: string): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s)>\]]+/gi)) {
		const url = match[0].replace(/[.,;:!?]+$/, '');
		if (!seen.has(url)) {
			seen.add(url);
			urls.push(url);
		}
	}
	return urls;
}
