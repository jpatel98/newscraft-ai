/**
 * E2E test helper: create a conversation pre-seeded with a user + assistant
 * message pair so the plan-timeline test can run its stream overlay on top of
 * an existing persisted turn.
 *
 * This ensures that after the intercepted stream ends and `invalidateAll()`
 * re-fetches the page data, the conversation already has messages in the DB,
 * so the Thread component's `lastAssistantId` remains set and the
 * `PlanTimeline` stays mounted throughout the test.
 *
 * Only active when `E2E_SECRET` is set (Playwright runs only).
 */
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { findAccountByPassword } from '$lib/server/db/accounts';
import { createConversation, addMessage } from '$lib/server/db/conversations';

export const POST: RequestHandler = async ({ request }) => {
	const secret = env.E2E_SECRET ?? '';
	if (!secret) throw error(404, 'not found');

	let body: { secret?: string; password?: string; userMessage?: string; assistantMessage?: string };
	try {
		body = (await request.json()) as {
			secret?: string;
			password?: string;
			userMessage?: string;
			assistantMessage?: string;
		};
	} catch {
		throw error(400, 'invalid json');
	}

	if (!body.secret || body.secret !== secret) throw error(403, 'forbidden');

	const password = body.password;
	if (!password || password.length < 8) throw error(400, 'password too short');

	const account = await findAccountByPassword(password);
	if (!account) throw error(404, 'account not found');

	// Create a new conversation for the test account
	const conversation = await createConversation(account.id);

	// Seed a prior user + assistant exchange so the thread is not empty.
	// After the intercepted stream ends and invalidateAll() re-fetches, these
	// persisted messages ensure lastAssistantId stays non-null.
	const userMessage = body.userMessage ?? 'seed user message';
	const assistantMessage = body.assistantMessage ?? 'seed assistant message';

	await addMessage({
		conversationId: conversation.id,
		role: 'user',
		content: userMessage
	});
	await addMessage({
		conversationId: conversation.id,
		role: 'assistant',
		content: assistantMessage
	});

	return json({ ok: true, id: conversation.id });
};
