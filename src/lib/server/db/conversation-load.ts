import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import { db } from './index';
import { messages, hermesRuns } from './schema';
import type { ConversationActionSummary, MessageRow } from './conversations';
import { HERMES_ACTIVE_STATES, type HermesRunRecord, type HermesRunMessageState } from './hermes-runs';
import { retryRead } from './read-retry';

export interface ConversationLoad {
	conversation: { id: string; title: string; updatedAt: number };
	messages: MessageRow[];
	totalCount: number;
	activeRun: HermesRunRecord | null;
	durableRuns: HermesRunMessageState[];
	actionSummary: ConversationActionSummary;
}

// Preserve Drizzle's camelCase keys inside JSON, including nullable fields.
function jsonRow(table: typeof messages | typeof hermesRuns): SQL {
	return sql`json_build_object(${sql.join(Object.entries(getTableColumns(table)).flatMap(
		([key, column]) => [sql`${key}::text`, sql`${column}`]
	), sql`, `)})`;
}

/** One snapshot and one network trip, with ownership gating every subquery. */
export async function getConversationLoad(accountId: string, conversationId: string, limit: number): Promise<ConversationLoad | null> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid message page size');
	const rows = await retryRead<Array<{ snapshot: ConversationLoad }>>(() => db.execute(sql`
		WITH owned AS MATERIALIZED (
			SELECT id, account_id, title, updated_at FROM conversations
			WHERE id = ${conversationId} AND account_id = ${accountId}
		), page AS MATERIALIZED (
			SELECT ${jsonRow(messages)} AS value, messages.id, messages.created_at
			FROM messages WHERE conversation_id = (SELECT id FROM owned)
			ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}
		)
		SELECT json_build_object(
			'conversation', json_build_object('id', owned.id, 'title', owned.title, 'updatedAt', owned.updated_at),
			'messages', COALESCE((SELECT json_agg(value ORDER BY created_at, id) FROM page), '[]'::json),
			'totalCount', (SELECT count(*) FROM messages WHERE conversation_id = owned.id),
			'activeRun', (SELECT ${jsonRow(hermesRuns)} FROM hermes_runs
				WHERE account_id = owned.account_id AND conversation_id = owned.id
				AND state IN (${sql.join(HERMES_ACTIVE_STATES.map(state => sql`${state}`), sql`, `)})
				ORDER BY updated_at DESC LIMIT 1),
			'durableRuns', COALESCE((SELECT json_agg(json_build_object(
				'assistantMessageId', assistant_message_id, 'state', state, 'errorMessage', error_message
			)) FROM (
				SELECT DISTINCT ON (assistant_message_id) assistant_message_id, state, error_message
				FROM hermes_runs WHERE account_id = owned.account_id AND conversation_id = owned.id
				AND assistant_message_id IN (SELECT id FROM page)
				ORDER BY assistant_message_id, created_at DESC, id DESC
			) latest_runs), '[]'::json),
			'actionSummary', json_build_object(
				'latestUser', (SELECT ${jsonRow(messages)} FROM messages
					WHERE conversation_id = owned.id AND role = 'user' ORDER BY created_at DESC, id DESC LIMIT 1),
				'latestAssistant', (SELECT json_build_object('id', id) FROM messages
					WHERE conversation_id = owned.id AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1),
				'latestReadyAssistant', (SELECT json_build_object('id', id) FROM messages
					WHERE conversation_id = owned.id AND role = 'assistant' AND partial = 0 ORDER BY created_at DESC, id DESC LIMIT 1),
				'latestUnfinishedAssistant', (SELECT json_build_object('id', id) FROM messages
					WHERE conversation_id = owned.id AND role = 'assistant' AND partial = 1 ORDER BY created_at DESC, id DESC LIMIT 1)
			)
		) AS snapshot FROM owned
	`));
	return (rows[0]?.snapshot as ConversationLoad | undefined) ?? null;
}
