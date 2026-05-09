import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createConversation } from '$lib/server/db/conversations';

interface Body {
	system_prompt?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	let body: Body = {};
	try {
		body = (await request.json()) as Body;
	} catch {
		/* empty body is fine */
	}
	const convo = createConversation(locals.user.id, body.system_prompt?.trim() || undefined);
	return json({ id: convo.id });
};
