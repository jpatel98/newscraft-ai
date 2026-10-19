/**
 * Disposable browser-fixture endpoint for Story ledger pane checks.
 *
 * Enabled only by the Playwright E2E secret. It writes a chat and runs ledger
 * blocks through the real upsert (matcher without a judge, planner, evidence),
 * so the pane is tested against what production would store.
 */
import { eq } from 'drizzle-orm';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { findAccountByPassword } from '$lib/server/db/accounts';
import { createConversation, getConversation } from '$lib/server/db/conversations';
import { db } from '$lib/server/db/index';
import { conversations, messages } from '$lib/server/db/schema';
import { upsertStoryClaims } from '$lib/server/db/story-claims';
import { citationSources } from '$lib/utils/claim-evidence';
import { normalizeLedgerClaim, type LedgerClaim } from '$lib/utils/story-ledger';

type FixtureBody = {
	secret?: string;
	password?: string;
	conversationId?: string;
	title?: string;
	/** One ledger block: raw claims as the worker writes them, and the answer's citations. */
	claims?: unknown[];
	citations?: { citationNumber: number; url: string; publicationDate?: string | null }[];
	at?: number;
};

export const POST: RequestHandler = async ({ request }) => {
	const secret = env.E2E_SECRET ?? '';
	const body = (await request.json().catch(() => null)) as FixtureBody | null;
	if (!body || typeof body !== 'object') throw error(400, 'invalid json');
	if (!secret || body.secret !== secret) throw error(403, 'forbidden');
	if (!body.password || body.password.length < 8) throw error(400, 'password too short');
	const account = await findAccountByPassword(body.password);
	if (!account) throw error(404, 'account not found');

	let conversationId = body.conversationId ?? '';
	if (conversationId) {
		if (!(await getConversation(account.id, conversationId))) throw error(404, 'not found');
	} else {
		const conversation = await createConversation(account.id);
		conversationId = conversation.id;
		const now = Date.now();
		await db.insert(messages).values([
			{ id: `ledger-${conversationId}-u`, conversationId, role: 'user', content: 'What do we know?', toolCalls: null, partial: 0, resumeClaimedAt: null, createdAt: now - 2 },
			{ id: `ledger-${conversationId}-a`, conversationId, role: 'assistant', content: 'Here is what we know.', toolCalls: null, partial: 0, resumeClaimedAt: null, createdAt: now - 1 }
		]);
		await db.update(conversations).set({ title: body.title ?? 'Ledger fixture', updatedAt: now }).where(eq(conversations.id, conversationId));
	}
	const claims = (body.claims ?? []).map(normalizeLedgerClaim).filter((claim): claim is LedgerClaim => claim !== null);
	const result = await upsertStoryClaims(conversationId, null, claims, body.at ?? Date.now(), null, citationSources(body.citations ?? []));
	return json({ ok: true, conversationId, ...result });
};
