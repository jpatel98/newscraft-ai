import { env } from '$env/dynamic/private';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { boardPostId, parseCronMarkdown, timestampFromFilename } from '$lib/utils/board';
import { upsertChannelPost } from '$lib/server/db/channel-posts';

interface Body {
	id?: unknown;
	jobId?: unknown;
	channel?: unknown;
	runTime?: unknown;
	schedule?: unknown;
	filename?: unknown;
	filePathDisplay?: unknown;
	responseMarkdown?: unknown;
	markdown?: unknown;
	sourceMtimeMs?: unknown;
}

function authToken(request: Request): string {
	const auth = request.headers.get('authorization') || '';
	if (!auth.toLowerCase().startsWith('bearer ')) return '';
	return auth.slice(7).trim();
}

function expectedToken(): string {
	return (env.HERMES_INGEST_KEY || env.HERMES_API_KEY || '').trim();
}

function text(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

function parseInput(body: Body) {
	const markdown = text(body.responseMarkdown) || text(body.markdown);
	if (!markdown) throw error(400, 'markdown is required');

	const parsed = parseCronMarkdown(markdown, text(body.jobId) || 'unknown');
	const jobId = text(body.jobId) || parsed.jobId || 'unknown';
	const filename = text(body.filename) || `${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
	const filePathDisplay = text(body.filePathDisplay) || `${jobId}/${filename}`;
	const runTime = text(body.runTime) || parsed.runTime || timestampFromFilename(filename);
	const schedule = text(body.schedule) || parsed.schedule || null;
	const channel = text(body.channel) || parsed.channel || jobId;
	const id = text(body.id) || boardPostId(jobId, filename);
	const sourceMtimeMs = Number(body.sourceMtimeMs);

	return {
		id,
		jobId,
		channel,
		runTime,
		schedule,
		filename,
		filePathDisplay,
		responseMarkdown: parsed.responseMarkdown,
		preview: parsed.preview,
		sourceMtimeMs: Number.isFinite(sourceMtimeMs) ? sourceMtimeMs : Date.now()
	};
}

export const POST: RequestHandler = async ({ request }) => {
	const expected = expectedToken();
	if (!expected) throw error(503, 'HERMES_INGEST_KEY or HERMES_API_KEY must be configured');
	if (authToken(request) !== expected) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	upsertChannelPost(parseInput(body));
	return json({ ok: true });
};
