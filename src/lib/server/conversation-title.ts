import { completion, type AgentMessage } from '$lib/server/agent/transport';
import {
	getConversation,
	getMessagesBatch,
	parseContent,
	type MessagePageCursor,
	setConversationTitleIfCurrent,
	type ConversationRow
} from '$lib/server/db/conversations';

interface OpenAINonStream {
	choices?: Array<{ message?: { content?: string } }>;
}

interface ConversationTitleResult {
	row: ConversationRow;
	title: string;
	generated: boolean;
}

const TITLE_SYSTEM =
	'Write a specific 4-to-8-word, sentence-case title that summarizes the user\'s main task or topic. ' +
	'Keep useful names, places, formats, and outcomes. Omit filler such as requests for help, greetings, and "this conversation." ' +
	'Reply with ONLY the title text — no label, quotes, markdown, or trailing punctuation.';
const TITLE_MESSAGE_BATCH_SIZE = 16;

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
		.trim();
	const words = (focused || cleaned).split(' ').slice(0, 8);
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
	if (!options.force && fresh.title) {
		return { row: fresh, title: fresh.title, generated: false };
	}

	const seedHistory: AgentMessage[] = [];
	let lastSeedId = conversationId;
	let cursor: MessagePageCursor | null = null;
	while (seedHistory.length < 4) {
		const sourceMessages = await getMessagesBatch(conversationId, cursor, TITLE_MESSAGE_BATCH_SIZE);
		if (sourceMessages.length === 0) break;
		for (const m of sourceMessages) {
			if (m.role !== 'user' && m.role !== 'assistant') continue;
			if (m.role === 'assistant' && m.partial === 1) continue;
			const parsed = parseContent(m.content);
			const text =
				typeof parsed === 'string'
					? parsed
					: parsed
							.filter((p) => p.type === 'text')
							.map((p) => (p as { text: string }).text)
							.join('\n');
			if (!text.trim()) continue;
			seedHistory.push({ role: m.role, content: text.trim() });
			lastSeedId = m.id;
			if (seedHistory.length === 4) break;
		}
		if (seedHistory.length === 4 || sourceMessages.length < TITLE_MESSAGE_BATCH_SIZE) break;
		const last = sourceMessages[sourceMessages.length - 1];
		cursor = { createdAt: last.createdAt, id: last.id };
	}
	if (seedHistory.length === 0) {
		return { row: fresh, title: fresh.title, generated: false };
	}
	let currentRow = fresh;
	let fallbackGenerated = false;
	if (isAutomaticTitlePlaceholder(fresh.title)) {
		const firstUser = seedHistory.find((message) => message.role === 'user');
		const fallback = fallbackConversationTitle(
			typeof firstUser?.content === 'string' ? firstUser.content : ''
		);
		const fallbackRow = await setConversationTitleIfCurrent(
			accountId,
			conversationId,
			fresh.title,
			fallback
		);
		if (!fallbackRow) {
			const latest = (await getConversation(accountId, conversationId)) ?? fresh;
			return { row: latest, title: latest.title, generated: false };
		}
		currentRow = fallbackRow;
		fallbackGenerated = Boolean(currentRow.title);
	}

	const titleMessages: AgentMessage[] = [
		{ role: 'system', content: TITLE_SYSTEM },
		...seedHistory,
		{ role: 'user', content: 'Title for this conversation:' }
	];
	const result = (await completion(
		{ messages: titleMessages, stream: false, max_tokens: 24 },
		{
			accountId,
			sessionId: `title-${conversationId}`,
			idempotencyKey: options.idempotencyKey ?? `title-${conversationId}-${lastSeedId}`
		}
	)) as OpenAINonStream;
	const raw = result.choices?.[0]?.message?.content ?? '';
	const title = sanitizeConversationTitle(raw);
	if (!title) return { row: currentRow, title: currentRow.title, generated: fallbackGenerated };

	const row = await setConversationTitleIfCurrent(
		accountId,
		conversationId,
		currentRow.title,
		title
	);
	if (!row) {
		const latest = (await getConversation(accountId, conversationId)) ?? currentRow;
		return { row: latest, title: latest.title, generated: false };
	}
	return { row, title: row.title || title, generated: true };
}
