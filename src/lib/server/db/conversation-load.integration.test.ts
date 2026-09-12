import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConversationLoad } from './conversation-load';
import { createConversation, getConversationActionSummary, getLatestMessagesPage, getMessageCount } from './conversations';
import { getActiveHermesRun, listHermesRunStatesForMessages } from './hermes-runs';
import { ensureMigrated, sql } from './index';

const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
describe.skipIf(!url)('combined conversation snapshot', () => {
	const account = `load-${Date.now()}`;
	beforeAll(async () => {
		await ensureMigrated();
		await sql`INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES (${account}, ${`${account}@example.test`}, 'Snapshot test', 'member', 1, 1)`;
	});
	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${account}`;
		await sql.end({ timeout: 1 });
	});
	it('returns null for another account or a missing conversation and handles an empty history', async () => {
		const conversation = await createConversation(account);
		expect(await getConversationLoad('other', conversation.id, 50)).toBeNull();
		expect(await getConversationLoad(account, 'missing', 50)).toBeNull();
		expect(await getConversationLoad(account, conversation.id, 50)).toMatchObject({
			messages: [], totalCount: 0, activeRun: null, durableRuns: [],
			actionSummary: { latestUser: null, latestAssistant: null, latestReadyAssistant: null, latestUnfinishedAssistant: null }
		});
	});
	it('matches the old reads for bounded history, ties, large payloads, off-page actions and run recovery', async () => {
		const c = await createConversation(account);
		for (let i = 0; i < 56; i++) {
			const id = `${c.id}-${String(i).padStart(2, '0')}`;
			await sql`INSERT INTO messages (id, conversation_id, role, content, tool_calls, partial, created_at)
				VALUES (${id}, ${c.id}, ${i === 0 ? 'user' : 'assistant'}, ${i === 0 ? '\u0001P:[{"type":"text","text":"Prompt"}]' : 'Long answer '.repeat(2000)}, ${i ? '{"tools":[]}' : null}, ${i % 3}, ${Math.floor(i / 2)})`;
		}
		const assistantId = `${c.id}-55`;
		for (const [id, state, createdAt] of [['old', 'failed', 1], ['new-a', 'cancelled', 2], ['new-b', 'writing', 2]] as const) {
			await sql`INSERT INTO hermes_runs (id, account_id, conversation_id, assistant_message_id,
				idempotency_key, tenant_key, session_id, input_json, state, answer_text, created_at, updated_at)
				VALUES (${`${c.id}-${id}`}, ${account}, ${c.id}, ${assistantId}, ${`${c.id}-${id}`}, 'test', 'test', '{}', ${state}, 'Saved answer', ${createdAt}, ${createdAt})`;
		}
		const snapshot = await getConversationLoad(account, c.id, 50);
		const page = await getLatestMessagesPage(c.id, 50);
		expect(snapshot?.messages).toEqual(page);
		expect(snapshot?.messages).toHaveLength(51);
		expect(snapshot?.totalCount).toEqual(await getMessageCount(c.id));
		expect(snapshot?.actionSummary).toEqual(await getConversationActionSummary(c.id));
		expect(snapshot?.activeRun).toEqual(await getActiveHermesRun(account, c.id));
		expect(snapshot?.durableRuns).toEqual(await listHermesRunStatesForMessages(account, c.id, page.map(m => m.id)));
		expect(snapshot?.durableRuns[0]).toMatchObject({ state: 'writing' });
		expect(snapshot?.actionSummary.latestUser?.id).toBe(`${c.id}-00`);
	});
});
