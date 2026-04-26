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
	role: 'user' | 'assistant' | 'system' | 'tool' | 'thread';
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
const PARTS_PREFIX = 'P:';

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

function tokens(raw: string): string[] {
	return raw
		.toLocaleLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

function likeTerm(t: string): string {
	return `%${t.replace(/[\\%_]/g, '\\$&')}%`;
}

function allTermsWhere(column: string, terms: string[]): string {
	return terms.map(() => `lower(${column}) LIKE ? ESCAPE '\\'`).join(' AND ');
}

function textContent(stored: string): string {
	if (!stored.startsWith(PARTS_PREFIX)) return stored;
	try {
		const parsed = JSON.parse(stored.slice(PARTS_PREFIX.length)) as unknown;
		if (!Array.isArray(parsed)) return stored;
		return parsed
			.map((part) => {
				const p = part as { type?: unknown; text?: unknown };
				return p.type === 'text' && typeof p.text === 'string' ? p.text : '';
			})
			.filter(Boolean)
			.join('\n');
	} catch {
		return stored;
	}
}

function markSnippet(text: string, terms: string[], max = 180): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (!clean) return '';
	const lower = clean.toLocaleLowerCase();
	const first = terms
		.map((t) => lower.indexOf(t))
		.filter((i) => i >= 0)
		.sort((a, b) => a - b)[0];
	const start = first && first > 40 ? Math.max(0, first - 40) : 0;
	const clipped = `${start > 0 ? '…' : ''}${clean.slice(start, start + max)}${
		start + max < clean.length ? '…' : ''
	}`;
	const pattern = new RegExp(
		`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
		'gi'
	);
	return clipped.replace(pattern, '<mark>$1</mark>');
}

function addUnique(results: Result[], seen: Set<string>, row: Result): void {
	const key = `${row.conversationId}:${row.messageId || 'thread'}:${row.role}`;
	if (seen.has(key)) return;
	seen.add(key);
	results.push(row);
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
	const terms = tokens(raw);
	if (!match) return json({ results: [] satisfies Result[] });

	const requested = Number.isFinite(body.limit) ? Number(body.limit) : DEFAULT_LIMIT;
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested) || DEFAULT_LIMIT));

	const results: Result[] = [];
	const seen = new Set<string>();

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
		.all(...likeParams, limit) as Row[];

	for (const row of titleRows) {
		addUnique(results, seen, {
			...row,
			role: 'thread',
			snippet: markSnippet(row.conversationTitle || 'Untitled thread', terms)
		});
	}

	try {
		const rows = sqliteClient.prepare(SQL).all(match, limit) as Row[];
		for (const row of rows) addUnique(results, seen, row);
	} catch {
		// Fall through to the LIKE scan below. Older or partially migrated local
		// databases can have a stale FTS table; title/content search should still work.
	}

	if (results.length < limit) {
		const messageRows = sqliteClient
			.prepare(
				`
SELECT
  m.id               AS messageId,
  m.conversation_id  AS conversationId,
  c.title            AS conversationTitle,
  m.role             AS role,
  m.content          AS snippet,
  m.created_at       AS createdAt
FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE ${allTermsWhere('m.content', terms)}
ORDER BY m.created_at DESC
LIMIT ?
`
			)
			.all(...likeParams, limit) as Row[];

		for (const row of messageRows) {
			addUnique(results, seen, {
				...row,
				snippet: markSnippet(textContent(row.snippet), terms)
			});
			if (results.length >= limit) break;
		}
	}

	return json({ results: results.slice(0, limit) satisfies Result[] });
};
