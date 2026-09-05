/**
 * Disposable browser-fixture endpoint for conversation history checks.
 *
 * This route is enabled only by the Playwright E2E secret. It writes synthetic
 * rows into the explicitly supplied test database and has no production use.
 */
import { and, eq } from 'drizzle-orm';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { findAccountByPassword } from '$lib/server/db/accounts';
import { createConversation, getConversation, getMessageById } from '$lib/server/db/conversations';
import { db } from '$lib/server/db/index';
import { conversations, messages } from '$lib/server/db/schema';

const MAX_FIXTURE_ROWS = 2_000;

type FixtureBody = {
	secret?: string;
	password?: string;
	count?: number;
	conversationId?: string;
	action?: 'update' | 'delete';
	messageId?: string;
	content?: string;
};

function parseBody(value: unknown): FixtureBody {
	if (!value || typeof value !== 'object') throw error(400, 'invalid json');
	return value as FixtureBody;
}

async function authorize(body: FixtureBody) {
	const secret = env.E2E_SECRET ?? '';
	if (!secret || body.secret !== secret) throw error(403, 'forbidden');
	if (!body.password || body.password.length < 8) throw error(400, 'password too short');
	const account = await findAccountByPassword(body.password);
	if (!account) throw error(404, 'account not found');
	return account;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: FixtureBody;
	try {
		body = parseBody(await request.json());
	} catch (cause) {
		if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
		throw error(400, 'invalid json');
	}
	const account = await authorize(body);

	if (body.action) {
		if (!body.conversationId || !body.messageId) throw error(400, 'message target required');
		const conversation = await getConversation(account.id, body.conversationId);
		if (!conversation) throw error(404, 'not found');
		const target = await getMessageById(body.messageId);
		if (!target || target.conversationId !== conversation.id) throw error(404, 'not found');
		if (body.action === 'update') {
			if (typeof body.content !== 'string') throw error(400, 'content required');
			await db
				.update(messages)
				.set({ content: body.content })
				.where(and(eq(messages.id, target.id), eq(messages.conversationId, conversation.id)));
			return json({ ok: true, action: 'update', messageId: target.id });
		}
		await db
			.delete(messages)
			.where(and(eq(messages.id, target.id), eq(messages.conversationId, conversation.id)));
		return json({ ok: true, action: 'delete', messageId: target.id });
	}

	const count = body.count ?? 1_000;
	if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FIXTURE_ROWS) {
		throw error(400, 'count is out of range');
	}
	const conversation = await createConversation(account.id);
	const base = Date.now() - count;
	const rows = Array.from({ length: count }, (_, index) => ({
		id: `history-${conversation.id}-${String(index).padStart(4, '0')}`,
		conversationId: conversation.id,
		role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
		content: `History message ${String(index).padStart(4, '0')}`,
		toolCalls: null,
		partial: 0,
		resumeClaimedAt: null,
		createdAt: base + index
	}));
	await db.insert(messages).values(rows);
	await db
		.update(conversations)
		.set({ updatedAt: base + count })
		.where(eq(conversations.id, conversation.id));
	return json({
		ok: true,
		conversationId: conversation.id,
		count,
		firstId: rows[0].id,
		targetId: rows[Math.floor(count / 2)].id,
		latestId: rows[count - 1].id,
		latestAssistantId: rows[count - 1].role === 'assistant' ? rows[count - 1].id : null,
		messageIds: rows.map((row) => row.id)
	});
};
