import { completion, type AgentMessage } from '$lib/server/agent/transport';
import {
	getConversation,
	getMessages,
	parseContent,
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
	'You generate a 4-to-8-word, sentence-case title for a conversation. ' +
	'Reply with ONLY the title text — no quotes, no markdown, no trailing punctuation.';

export function fallbackConversationTitle(content: string): string {
	const cleaned = content
		.replace(/^Production polish audit\s+[^.]+\.\s*/i, '')
		.replace(/[`*_#>[\]{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return 'New conversation';
	const words = cleaned.split(' ').slice(0, 8);
	const title = words.join(' ').replace(/[.,;:!?]+$/, '');
	return title.slice(0, 80) || 'New conversation';
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

	const sourceMessages = (await getMessages(conversationId)).filter(
		(m) => m.role === 'user' || m.role === 'assistant'
	);
	const seedHistory = sourceMessages.slice(0, 4).map<AgentMessage>((m) => {
		const parsed = parseContent(m.content);
		const text =
			typeof parsed === 'string'
				? parsed
				: parsed
						.filter((p) => p.type === 'text')
						.map((p) => (p as { text: string }).text)
						.join('\n');
		return { role: m.role as 'user' | 'assistant', content: text };
	});
	if (seedHistory.length === 0) {
		return { row: fresh, title: fresh.title, generated: false };
	}
	let currentRow = fresh;
	let fallbackGenerated = false;
	if (!fresh.title) {
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
	const lastSeedId = sourceMessages[Math.min(sourceMessages.length, 4) - 1]?.id ?? conversationId;
	const result = (await completion(
		{ messages: titleMessages, stream: false, max_tokens: 24 },
		{
			accountId,
			idempotencyKey: options.idempotencyKey ?? `title-${conversationId}-${lastSeedId}`
		}
	)) as OpenAINonStream;
	const raw = result.choices?.[0]?.message?.content ?? '';
	const title = raw.trim().replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').slice(0, 80);
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
