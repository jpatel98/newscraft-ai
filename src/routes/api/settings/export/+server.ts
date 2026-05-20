import { error, type RequestHandler } from '@sveltejs/kit';
import { getMessages, listConversations, parseContent } from '$lib/server/db/conversations';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const convos = await listConversations(locals.user.id, 10_000);
	const exported = await Promise.all(
		convos.map(async (conversation) => ({
			conversation,
			messages: await getMessages(conversation.id)
		}))
	);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const enc = new TextEncoder();
			try {
				for (const { conversation: c, messages: msgs } of exported) {
					controller.enqueue(
						enc.encode(
							JSON.stringify({
								type: 'conversation',
								id: c.id,
								title: c.title,
								createdAt: c.createdAt,
								updatedAt: c.updatedAt
							}) + '\n'
						)
					);
					for (const m of msgs) {
						controller.enqueue(
							enc.encode(
								JSON.stringify({
									type: 'message',
									conversationId: c.id,
									id: m.id,
									role: m.role,
									content: parseContent(m.content),
									createdAt: m.createdAt
								}) + '\n'
							)
						);
					}
				}
				controller.close();
			} catch (e) {
				controller.error(e);
			}
		}
	});

	const today = new Date().toISOString().slice(0, 10);
	return new Response(stream, {
		headers: {
			'Content-Type': 'application/x-ndjson',
			'Content-Disposition': `attachment; filename="hermes-export-${today}.jsonl"`,
			'Cache-Control': 'no-store'
		}
	});
};
