import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { parseContent } from '$lib/server/db/conversations';
import { contentText } from '$lib/types';
import { dedupeByConversation, searchTokens, type SearchRow } from '$lib/utils/search-dedupe';
import { markSearchSnippet, visibleSearchSnippet } from '$lib/utils/search-snippets';

interface Body {
	q?: string;
	limit?: number;
}

type Result = SearchRow;
type Row = SearchRow;
type MessageSearchRow = SearchRow & { content: string };

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function likeTerm(t: string): string {
	return `%${t.replace(/[\\%_]/g, '\\$&')}%`;
}

function quoted(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function allTermsWhere(column: string, terms: string[]): string {
	return terms.map((term) => `lower(${column}) LIKE lower(${quoted(likeTerm(term))}) ESCAPE '\\'`).join(' AND ');
}

function textContent(stored: string): string {
	return contentText(parseContent(stored));
}

function visibleMessageSnippet(stored: string, terms: string[]): string | null {
	return visibleSearchSnippet(textContent(stored), terms);
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	const raw = (body.q ?? '').toString();
	const terms = searchTokens(raw);
	if (terms.length === 0) return json({ results: [] satisfies Result[] });

	const requested = Number.isFinite(body.limit) ? Number(body.limit) : DEFAULT_LIMIT;
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested) || DEFAULT_LIMIT));

	// Over-fetch so the per-conversation collapse leaves us with a useful
	// page after duplicate suppression.
	const fetchLimit = Math.min(MAX_LIMIT, limit * 4);
	const collected: Row[] = [];
	const titleRows = (await sql.unsafe(`
		SELECT
			c.id AS "conversationId",
			c.title AS "conversationTitle",
			'' AS "messageId",
			'thread' AS role,
			c.title AS snippet,
			c.updated_at AS "createdAt"
		FROM conversations c
		WHERE ${allTermsWhere('c.title', terms)}
			AND c.account_id = ${quoted(locals.user.id)}
		ORDER BY c.pinned DESC, c.updated_at DESC
		LIMIT ${fetchLimit}
	`)) as Row[];

	for (const row of titleRows) {
		collected.push({
			...row,
			role: 'thread',
			snippet: markSearchSnippet(row.conversationTitle || 'Untitled thread', terms)
		});
	}

	if (collected.length < fetchLimit) {
		const messageRows = (await sql.unsafe(`
			SELECT
				m.id AS "messageId",
				m.conversation_id AS "conversationId",
				c.title AS "conversationTitle",
				m.role AS role,
				m.content AS content,
				m.created_at AS "createdAt"
			FROM messages m
			JOIN conversations c ON c.id = m.conversation_id
			WHERE ${allTermsWhere('m.content', terms)}
				AND c.account_id = ${quoted(locals.user.id)}
				AND m.role IN ('user', 'assistant')
			ORDER BY m.created_at DESC
			LIMIT ${fetchLimit}
		`)) as MessageSearchRow[];

		for (const row of messageRows) {
			const snippet = visibleMessageSnippet(row.content, terms);
			if (!snippet) continue;
			collected.push({
				conversationId: row.conversationId,
				conversationTitle: row.conversationTitle,
				messageId: row.messageId,
				role: row.role,
				snippet,
				createdAt: row.createdAt
			});
		}
	}

	const deduped = dedupeByConversation(collected).slice(0, limit);
	return json({ results: deduped satisfies Result[] });
};
