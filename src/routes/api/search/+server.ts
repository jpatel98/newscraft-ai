import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sqliteClient } from '$lib/server/db';
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

// FTS5 reserves `"`, `*`, `:`, `-`, `^`, `(`, `)`, `AND`/`OR`/`NOT`. Splitting on
// whitespace and double-quoting each token (with `"` doubled) turns any input
// into a literal phrase-AND query that the parser can't choke on.
function sanitize(q: string): string {
	return searchTokens(q)
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => `"${t.replace(/"/g, '""')}"`)
		.join(' ');
}

const SQL = `
SELECT
  m.id              AS messageId,
  m.conversation_id AS conversationId,
  c.title           AS conversationTitle,
  m.role            AS role,
  m.content         AS content,
  m.created_at      AS createdAt
FROM messages_fts
JOIN messages m ON m.rowid = messages_fts.rowid
JOIN conversations c ON c.id = m.conversation_id
WHERE messages_fts MATCH ?
  AND m.role IN ('user', 'assistant')
ORDER BY rank
LIMIT ?
`;

function likeTerm(t: string): string {
	return `%${t.replace(/[\\%_]/g, '\\$&')}%`;
}

function allTermsWhere(column: string, terms: string[]): string {
	return terms.map(() => `lower(${column}) LIKE ? ESCAPE '\\'`).join(' AND ');
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
	const match = sanitize(raw);
	const terms = searchTokens(raw);
	if (!match) return json({ results: [] satisfies Result[] });

	const requested = Number.isFinite(body.limit) ? Number(body.limit) : DEFAULT_LIMIT;
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested) || DEFAULT_LIMIT));

	// Over-fetch so the per-conversation collapse leaves us with a useful
	// page after duplicate suppression.
	const fetchLimit = Math.min(MAX_LIMIT, limit * 4);
	const collected: Row[] = [];

	const likeParams = terms.map(likeTerm);
	const titleRows = sqliteClient
		.prepare(
			`
SELECT
  c.id         AS conversationId,
  c.title      AS conversationTitle,
  ''           AS messageId,
  'thread'     AS role,
  c.title      AS snippet,
  c.updated_at AS createdAt
FROM conversations c
WHERE ${allTermsWhere('c.title', terms)}
ORDER BY c.pinned DESC, c.updated_at DESC
LIMIT ?
`
		)
		.all(...likeParams, fetchLimit) as Row[];

	for (const row of titleRows) {
		collected.push({
			...row,
			role: 'thread',
			snippet: markSearchSnippet(row.conversationTitle || 'Untitled thread', terms)
		});
	}

	try {
		const rows = sqliteClient.prepare(SQL).all(match, fetchLimit) as MessageSearchRow[];
		for (const row of rows) {
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
	} catch {
		// Fall through to the LIKE scan below. Older or partially migrated local
		// databases can have a stale FTS table; title/content search should still work.
	}

	if (collected.length < fetchLimit) {
		const messageRows = sqliteClient
			.prepare(
				`
SELECT
  m.id               AS messageId,
  m.conversation_id  AS conversationId,
  c.title            AS conversationTitle,
  m.role             AS role,
  m.content          AS content,
  m.created_at       AS createdAt
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE ${allTermsWhere('m.content', terms)}
  AND m.role IN ('user', 'assistant')
ORDER BY m.created_at DESC
LIMIT ?
`
			)
			.all(...likeParams, fetchLimit) as MessageSearchRow[];

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
