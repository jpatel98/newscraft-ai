import { completion, type AgentMessage } from '$lib/server/agent/transport';
import {
	getConversation,
	getMessages,
	parseContent,
	setConversationTitle,
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

	const titleMessages: AgentMessage[] = [
		{ role: 'system', content: TITLE_SYSTEM },
		...seedHistory,
		{ role: 'user', content: 'Title for this conversation:' }
	];
	const lastSeedId = sourceMessages[Math.min(sourceMessages.length, 4) - 1]?.id ?? conversationId;
	const result = (await completion(
		{ messages: titleMessages, stream: false, max_tokens: 24 },
		{ idempotencyKey: options.idempotencyKey ?? `title-${conversationId}-${lastSeedId}` }
	)) as OpenAINonStream;
	const raw = result.choices?.[0]?.message?.content ?? '';
	const title = raw.trim().replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').slice(0, 80);
	if (!title) return { row: fresh, title: fresh.title, generated: false };

	const row = (await setConversationTitle(accountId, conversationId, title)) ?? fresh;
	return { row, title: row.title || title, generated: true };
}
