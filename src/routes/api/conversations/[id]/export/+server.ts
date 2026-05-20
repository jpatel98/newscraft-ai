import { error, type RequestHandler } from '@sveltejs/kit';
import { getConversation, getMessages } from '$lib/server/db/conversations';

function pad(n: number): string {
	return n.toString().padStart(2, '0');
}

function fmtTime(ts: number): string {
	const d = new Date(ts);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function speakerName(role: string): string {
	if (role === 'user') return 'You';
	if (role === 'assistant') return 'NewsCraft';
	return role;
}

function safeFilename(title: string, fallbackId: string): string {
	const base = (title || fallbackId).trim().toLowerCase();
	const slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
	return slug || fallbackId;
}

export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id required');

	const convo = await getConversation(locals.user.id, id);
	if (!convo) throw error(404, 'not found');

	const format = (url.searchParams.get('format') ?? 'md').toLowerCase();
	if (format !== 'md' && format !== 'jsonl') throw error(400, 'format must be md or jsonl');

	const messages = await getMessages(id);
	const slug = safeFilename(convo.title, convo.id);

	if (format === 'md') {
		const lines: string[] = [];
		lines.push(`# ${convo.title || 'Untitled thread'}`);
		lines.push('');
		for (const m of messages) {
			lines.push(`**${speakerName(m.role)}** (${fmtTime(m.createdAt)})`);
			lines.push('');
			lines.push(m.content);
			lines.push('');
		}
		const body = lines.join('\n');
		return new Response(body, {
			headers: {
				'Content-Type': 'text/markdown; charset=utf-8',
				'Content-Disposition': `attachment; filename="${slug}.md"`,
				'Cache-Control': 'no-store'
			}
		});
	}

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			try {
				controller.enqueue(
					enc.encode(
						JSON.stringify({
							type: 'conversation',
							id: convo.id,
							title: convo.title,
							createdAt: convo.createdAt,
							updatedAt: convo.updatedAt
						}) + '\n'
					)
				);
				for (const m of messages) {
					controller.enqueue(
						enc.encode(
							JSON.stringify({
								type: 'message',
								conversationId: convo.id,
								id: m.id,
								role: m.role,
								content: m.content,
								createdAt: m.createdAt
							}) + '\n'
						)
					);
				}
				controller.close();
			} catch (e) {
				controller.error(e);
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'application/x-ndjson',
			'Content-Disposition': `attachment; filename="${slug}.jsonl"`,
			'Cache-Control': 'no-store'
		}
	});
};
