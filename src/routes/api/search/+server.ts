import { error, json, type RequestHandler } from '@sveltejs/kit';
import { sqliteClient } from '$lib/server/db';

interface Body {
	q?: string;
	limit?: number;
}

interface Result {
	conversationId: string;
	conversationTitle: string;
	messageId: string;
	role: 'user' | 'assistant' | 'system' | 'tool';
	snippet: string;
	createdAt: number;
}

interface Row {
	messageId: string;
	conversationId: string;
	conversationTitle: string;
	role: Result['role'];
	snippet: string;
	createdAt: number;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// FTS5 reserves `"`, `*`, `:`, `-`, `^`, `(`, `)`, `AND`/`OR`/`NOT`. Splitting on
// whitespace and double-quoting each token (with `"` doubled) turns any input
// into a literal phrase-AND query that the parser can't choke on.
function sanitize(q: string): string {
	return q
		.split(/\s+/)
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
  snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet,
  m.created_at      AS createdAt
FROM messages_fts
JOIN messages m ON m.rowid = messages_fts.rowid
JOIN conversations c ON c.id = m.conversation_id
WHERE messages_fts MATCH ?
ORDER BY rank
LIMIT ?
`;

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
	if (!match) return json({ results: [] satisfies Result[] });

	const requested = Number.isFinite(body.limit) ? Number(body.limit) : DEFAULT_LIMIT;
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested) || DEFAULT_LIMIT));

	const rows = sqliteClient.prepare(SQL).all(match, limit) as Row[];
	return json({ results: rows satisfies Result[] });
};
