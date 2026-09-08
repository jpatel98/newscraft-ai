import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversation, getConversationActionSummary } from './conversations';
import { ensureMigrated, sql } from './index';
import { createSession, getActiveSessionAccount } from './sessions';

const databaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

describe.skipIf(!databaseUrl)('conversation action summary repository', () => {
	const accountId = `action-summary-test-${Date.now()}`;

	beforeAll(async () => {
		await ensureMigrated();
		const now = Date.now();
		await sql`
			INSERT INTO accounts (id, email, name, role, created_at, updated_at)
			VALUES (${accountId}, ${`${accountId}@example.test`}, 'Action summary test', 'member', ${now}, ${now})
		`;
	});

	afterAll(async () => {
		await sql`DELETE FROM accounts WHERE id = ${accountId}`;
		await sql.end({ timeout: 1 });
	});

	it('returns each latest action candidate with the prior ordering semantics', async () => {
		const conversation = await createConversation(accountId);
		const rows = [
			['user-old', 'user', 10, 0],
			['user-new', 'user', 20, 0],
			['ready-old', 'assistant', 30, 0],
			['ready-new', 'assistant', 40, 0],
			['unfinished-old', 'assistant', 50, 1],
			['unfinished-new', 'assistant', 60, 1],
			['assistant-latest', 'assistant', 70, 2]
		] as const;
		for (const [id, role, createdAt, partial] of rows) {
			await sql`
				INSERT INTO messages
					(id, conversation_id, role, content, tool_calls, partial, resume_claimed_at, created_at)
				VALUES (${id}, ${conversation.id}, ${role}, ${id}, NULL, ${partial}, NULL, ${createdAt})
			`;
		}

		await expect(getConversationActionSummary(conversation.id)).resolves.toEqual({
			latestUser: expect.objectContaining({ id: 'user-new', createdAt: 20 }),
			latestAssistant: expect.objectContaining({ id: 'assistant-latest', createdAt: 70 }),
			latestReadyAssistant: expect.objectContaining({ id: 'ready-new', createdAt: 40 }),
			latestUnfinishedAssistant: expect.objectContaining({ id: 'unfinished-new', createdAt: 60 })
		});
	});

	it('hydrates the account only for the matching active session', async () => {
		const session = await createSession(accountId, 1_000);
		await expect(getActiveSessionAccount(session.id, accountId, 301_001)).resolves.toMatchObject({
			session: { id: session.id, accountId },
			account: { id: accountId, email: `${accountId}@example.test` }
		});
		const refreshed = await getActiveSessionAccount(session.id, accountId, 301_001);
		expect(refreshed?.session.lastSeenAt).toBe(301_001);
		await expect(getActiveSessionAccount(session.id, 'another-account', 301_001)).resolves.toBeNull();

		const expired = await createSession(accountId, 1_000);
		await expect(getActiveSessionAccount(expired.id, accountId, expired.expiresAt)).resolves.toBeNull();
		const revoked = await createSession(accountId, 1_000);
		await sql`UPDATE sessions SET revoked_at = 2_000 WHERE id = ${revoked.id}`;
		await expect(getActiveSessionAccount(revoked.id, accountId, 2_001)).resolves.toBeNull();
	});
});
