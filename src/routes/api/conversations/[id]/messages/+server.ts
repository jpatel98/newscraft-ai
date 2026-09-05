import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	getConversation,
	getLatestMessagesPage,
	getMessageById,
	getMessageCount,
	getMessageWindow,
	getMessagesBefore,
	getMessagesBetween,
	getMessagesByIds,
	type MessagePageCursor,
	type MessageRow
} from '$lib/server/db/conversations';
import { listHermesRunStatesForMessages } from '$lib/server/db/hermes-runs';
import {
	MESSAGE_PAGE_MAX_BYTES,
	MESSAGE_PAGE_SIZE,
	TARGET_WINDOW_AFTER,
	TARGET_WINDOW_BEFORE,
	toThreadMessage,
	trimNewestMessages,
	trimOldestMessages,
	trimTargetWindow,
	type ThreadMessageView
} from '$lib/server/conversation-history';

const MAX_CURSOR_ID_LENGTH = 256;
const MAX_IDS = 100;

type HistoryMode = 'latest' | 'older' | 'range' | 'around' | 'ids';

function positiveInt(value: string | null, fallback: number, max: number, label: string): number {
	if (value == null) return fallback;
	if (!/^\d+$/.test(value)) throw error(400, `${label} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
		throw error(400, `${label} is out of range`);
	}
	return parsed;
}

function decodeCursor(value: string | null, label: string): MessagePageCursor {
	if (!value) throw error(400, `${label} cursor required`);
	try {
		const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
		const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
		if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor');
		const cursor = parsed as { createdAt?: unknown; id?: unknown };
		if (
			!Number.isSafeInteger(cursor.createdAt) ||
			(cursor.createdAt as number) < 0 ||
			typeof cursor.id !== 'string' ||
			!cursor.id ||
			cursor.id.length > MAX_CURSOR_ID_LENGTH
		) {
			throw new Error('invalid cursor');
		}
		return { createdAt: cursor.createdAt as number, id: cursor.id };
	} catch {
		throw error(400, `${label} cursor is invalid`);
	}
}

async function requireOwnedMessage(
	conversationId: string,
	cursor: MessagePageCursor,
	label: string
): Promise<MessageRow> {
	const row = await getMessageById(cursor.id);
	if (!row || row.conversationId !== conversationId || row.createdAt !== cursor.createdAt) {
		throw error(404, 'not found');
	}
	return row;
}

function mapRuns(rows: MessageRow[], runs: Awaited<ReturnType<typeof listHermesRunStatesForMessages>>) {
	return new Map(runs.map((run) => [run.assistantMessageId, run]));
}

function serializeRows(
	rows: MessageRow[],
	runs: Awaited<ReturnType<typeof listHermesRunStatesForMessages>>
): ThreadMessageView[] {
	const byMessage = mapRuns(rows, runs);
	return rows.map((row) => toThreadMessage(row, byMessage.get(row.id)));
}

function pageMeta(messages: ThreadMessageView[], hasOlder: boolean, hasNewer: boolean) {
	const first = messages[0];
	const last = messages[messages.length - 1];
	return {
		hasOlder,
		hasNewer,
		olderCursor: first ? { createdAt: first.createdAt ?? 0, id: first.id } : null,
		newerCursor: last ? { createdAt: last.createdAt ?? 0, id: last.id } : null
	};
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id;
	if (!conversationId) throw error(400, 'conversation id required');
	// Resolve ownership before parsing any user-provided cursor or id list. All
	// missing and foreign anchors use the same safe response.
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');

	const query = url.searchParams;
	const hasBefore = query.has('before');
	const hasAfter = query.has('after');
	const hasAround = query.has('around');
	const hasIds = query.has('ids') || query.has('id');
	const requestedModes = [hasAround, hasIds, hasBefore && hasAfter, hasBefore && !hasAfter]
		.filter(Boolean).length;
	if (requestedModes > 1) throw error(400, 'conflicting history modes');

	const limit = positiveInt(query.get('limit'), MESSAGE_PAGE_SIZE, MESSAGE_PAGE_SIZE, 'limit');
	let mode: HistoryMode = 'latest';
	if (hasAround) mode = 'around';
	else if (hasIds) mode = 'ids';
	else if (hasBefore && hasAfter) mode = 'range';
	else if (hasBefore) mode = 'older';
	if (hasAfter && !hasBefore) throw error(400, 'before cursor required for a range');

	if (mode === 'latest') {
		const [candidateRows, totalCount] = await Promise.all([
			getLatestMessagesPage(conversation.id, limit),
			getMessageCount(conversation.id)
		]);
		const runs = await listHermesRunStatesForMessages(
			locals.user.id,
			conversation.id,
			candidateRows.map((row) => row.id)
		);
		const candidates = serializeRows(candidateRows, runs);
		const messages = trimNewestMessages(candidates, limit, MESSAGE_PAGE_MAX_BYTES);
		return json(
			{
				mode,
				messages,
				pageSize: limit,
				totalCount,
				gapBefore: totalCount > messages.length || candidateRows.length > messages.length,
				gapAfter: false,
				...pageMeta(messages, totalCount > messages.length || candidateRows.length > messages.length, false)
			},
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	if (mode === 'older') {
		const cursor = decodeCursor(query.get('before'), 'before');
		await requireOwnedMessage(conversation.id, cursor, 'before');
		const candidateRows = await getMessagesBefore(conversation.id, cursor, limit);
		const runs = await listHermesRunStatesForMessages(
			locals.user.id,
			conversation.id,
			candidateRows.map((row) => row.id)
		);
		const candidates = serializeRows(candidateRows, runs);
		const messages = trimNewestMessages(candidates, limit, MESSAGE_PAGE_MAX_BYTES);
		return json(
			{
				mode,
				messages,
				pageSize: limit,
				gapBefore: candidateRows.length > messages.length,
				gapAfter: false,
				...pageMeta(messages, candidateRows.length > messages.length, messages.length > 0)
			},
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	if (mode === 'range') {
		const after = decodeCursor(query.get('after'), 'after');
		const before = decodeCursor(query.get('before'), 'before');
		const [afterRow, beforeRow] = await Promise.all([
			requireOwnedMessage(conversation.id, after, 'after'),
			requireOwnedMessage(conversation.id, before, 'before')
		]);
		if (
			afterRow.createdAt > beforeRow.createdAt ||
			(afterRow.createdAt === beforeRow.createdAt && afterRow.id >= beforeRow.id)
		) {
			throw error(400, 'range boundaries are invalid');
		}
		const candidateRows = await getMessagesBetween(conversation.id, after, before, limit);
		const runs = await listHermesRunStatesForMessages(
			locals.user.id,
			conversation.id,
			candidateRows.map((row) => row.id)
		);
		const candidates = serializeRows(candidateRows, runs);
		const messages = trimOldestMessages(candidates, limit, MESSAGE_PAGE_MAX_BYTES);
		const more = candidateRows.length > messages.length;
		return json(
			{
				mode,
				messages,
				pageSize: limit,
				range: { after, before },
				hasMore: more,
				gapBefore: false,
				gapAfter: more,
				nextAfter: more && messages.length ? { createdAt: messages[messages.length - 1].createdAt ?? 0, id: messages[messages.length - 1].id } : null,
				...pageMeta(messages, false, false)
			},
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	if (mode === 'around') {
		const targetId = query.get('around');
		if (!targetId || targetId.length > MAX_CURSOR_ID_LENGTH) throw error(400, 'target is invalid');
		const beforeLimit = positiveInt(query.get('before_count'), TARGET_WINDOW_BEFORE, TARGET_WINDOW_BEFORE, 'before_count');
		const afterLimit = positiveInt(query.get('after_count'), TARGET_WINDOW_AFTER, TARGET_WINDOW_AFTER, 'after_count');
		const targetRow = await getMessageById(targetId);
		if (!targetRow || targetRow.conversationId !== conversation.id) throw error(404, 'not found');
		const window = await getMessageWindow(
			conversation.id,
			{ createdAt: targetRow.createdAt, id: targetRow.id },
			beforeLimit,
			afterLimit
		);
		const rows = [...window.before, targetRow, ...window.after];
		const runs = await listHermesRunStatesForMessages(
			locals.user.id,
			conversation.id,
			rows.map((row) => row.id)
		);
		const byMessage = mapRuns(rows, runs);
		const target = toThreadMessage(targetRow, byMessage.get(targetRow.id));
		const trimmed = trimTargetWindow(
			window.before.map((row) => toThreadMessage(row, byMessage.get(row.id))),
			target,
			window.after.map((row) => toThreadMessage(row, byMessage.get(row.id))),
			beforeLimit,
			afterLimit,
			MESSAGE_PAGE_MAX_BYTES
		);
		const messages = [...trimmed.before, trimmed.target, ...trimmed.after];
		const beforeHasMore = window.before.length > trimmed.before.length;
		const afterHasMore = window.after.length > trimmed.after.length;
		return json(
			{
				mode,
				targetId,
				messages,
				pageSize: beforeLimit + afterLimit + 1,
				gapBefore: beforeHasMore,
				gapAfter: afterHasMore,
				...pageMeta(messages, beforeHasMore, afterHasMore),
				beforeCursor: messages[0] ? { createdAt: messages[0].createdAt ?? 0, id: messages[0].id } : null,
				afterCursor: messages.at(-1) ? { createdAt: messages.at(-1)?.createdAt ?? 0, id: messages.at(-1)?.id ?? '' } : null
			},
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	const rawIds = [...query.getAll('ids').flatMap((value) => value.split(',')), ...query.getAll('id')]
		.map((id) => id.trim())
		.filter(Boolean);
	const ids = Array.from(new Set(rawIds));
	if (ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => id.length > MAX_CURSOR_ID_LENGTH)) {
		throw error(400, 'ids are invalid');
	}
	const rows = await getMessagesByIds(conversation.id, ids);
	const runs = await listHermesRunStatesForMessages(locals.user.id, conversation.id, ids);
	const messages = serializeRows(rows, runs);
	return json(
		{
			mode: 'ids',
			requestedIds: ids,
			messages,
			pageSize: ids.length,
			...pageMeta(messages, false, false)
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
