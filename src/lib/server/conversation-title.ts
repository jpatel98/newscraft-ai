import {
	getConversation,
	getMessagesBatch,
	parseContent,
	type MessagePageCursor,
	setConversationTitleIfCurrent,
	type ConversationRow
} from '$lib/server/db/conversations';

interface ConversationTitleResult {
	row: ConversationRow;
	title: string;
	generated: boolean;
}

const TITLE_MESSAGE_BATCH_SIZE = 16;
const TITLE_MAX_MESSAGE_BATCHES = 8;

function isAutomaticTitlePlaceholder(value: string | null | undefined): boolean {
	const normalized = (value ?? '').trim().toLowerCase();
	return !normalized || normalized === '(untitled)' || normalized === 'new chat';
}

export function sanitizeConversationTitle(value: string): string {
	const firstLine = value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return '';
	return firstLine
		.replace(/^title\s*:\s*/i, '')
		.replace(/^["'`*_#\s]+|["'`*_#\s]+$/g, '')
		.replace(/[.!?;:]+$/, '')
		.replace(/\s+/g, ' ')
		.trim()
		.split(' ')
		.slice(0, 10)
		.join(' ')
		.slice(0, 80)
		.trim();
}

export function fallbackConversationTitle(content: string): string {
	const cleaned = content
		.replace(/^Production polish audit\s+[^.]+\.\s*/i, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/\[\d+\]/g, '')
		.replace(/[`*_#>[\]{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return 'New conversation';
	const focused = cleaned
		.replace(/^(?:um|uh|hey|hi)[,:\s-]*/i, '')
		.replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '')
		.replace(/^please\s+/i, '')
		.replace(/^i\s+(?:would\s+like|want|need)\s+(?:us|you)\s+to\s+/i, '')
		.replace(/^(?:help\s+me\s+(?:to\s+)?|work\s+on\s+)/i, '')
		.replace(/^(?:what\s+(?:is|are)|tell\s+me\s+about)\s+(?:the\s+)?/i, '')
		.replace(/(?:\s+|[.!?]\s*)(?:use|include|cite)\s+(?:verified\s+)?sources[.!?]?$/i, '')
		.trim();
	const words = (focused || cleaned).split(/[.!?](?:\s|$)/)[0].split(' ').slice(0, 8);
	const title = words.join(' ').replace(/[.,;:!?]+$/, '');
	const bounded = title.slice(0, 80).trim();
	return bounded ? `${bounded.charAt(0).toUpperCase()}${bounded.slice(1)}` : 'New conversation';
}

export async function generateConversationTitle(
	accountId: string,
	conversationId: string,
	options: { force?: boolean; idempotencyKey?: string } = {}
): Promise<ConversationTitleResult | null> {
	const fresh = await getConversation(accountId, conversationId);
	if (!fresh) return null;
	if (!options.force && !isAutomaticTitlePlaceholder(fresh.title)) {
		return { row: fresh, title: fresh.title, generated: false };
	}

	// A title is a local projection of the user's task. It does not create an
	// unleased model request or an extra paid tool loop after completion.
	let firstRequest = '';
	let cursor: MessagePageCursor | null = null;
	for (let batch = 0; batch < TITLE_MAX_MESSAGE_BATCHES; batch += 1) {
		const sourceMessages = await getMessagesBatch(conversationId, cursor, TITLE_MESSAGE_BATCH_SIZE);
		if (sourceMessages.length === 0) break;
		for (const m of sourceMessages) {
			if (m.role !== 'user') continue;
			const parsed = parseContent(m.content);
			const text =
				typeof parsed === 'string'
					? parsed
					: parsed
							.filter((p) => p.type === 'text')
							.map((p) => (p as { text: string }).text)
							.join('\n');
			if (!text.trim()) continue;
			firstRequest = text.trim();
			break;
		}
		if (firstRequest || sourceMessages.length < TITLE_MESSAGE_BATCH_SIZE) break;
		const last = sourceMessages[sourceMessages.length - 1];
		cursor = { createdAt: last.createdAt, id: last.id };
	}
	if (!firstRequest) {
		return { row: fresh, title: fresh.title, generated: false };
	}
	const title = fallbackConversationTitle(firstRequest);
	if (title === fresh.title) return { row: fresh, title, generated: false };
	const row = await setConversationTitleIfCurrent(
		accountId,
		conversationId,
		fresh.title,
		title
	);
	if (!row) {
		const latest = (await getConversation(accountId, conversationId)) ?? fresh;
		return { row: latest, title: latest.title, generated: false };
	}
	return { row, title: row.title || title, generated: true };
}
