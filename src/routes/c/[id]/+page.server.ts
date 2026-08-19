import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getConversation, getMessages, parseContent } from '$lib/server/db/conversations';
import {
	getActiveHermesRun,
	listHermesRunsForConversation,
	snapshotFromRun
} from '$lib/server/db/hermes-runs';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convo = await getConversation(locals.user.id, params.id);
	if (!convo) throw error(404, 'not found');
	const [messages, activeRun, durableRuns] = await Promise.all([
		getMessages(convo.id),
		getActiveHermesRun(locals.user.id, convo.id),
		listHermesRunsForConversation(locals.user.id, convo.id)
	]);
	const runByAssistant = new Map<string, (typeof durableRuns)[number]>();
	for (const run of durableRuns) {
		if (!runByAssistant.has(run.assistantMessageId)) runByAssistant.set(run.assistantMessageId, run);
	}
	return {
		conversation: { id: convo.id, title: convo.title, updatedAt: convo.updatedAt },
		messages: messages.map((m) => ({
			id: m.id,
			role: m.role,
			content: parseContent(m.content),
			toolCalls: m.toolCalls,
			partial: m.partial === 1,
			createdAt: m.createdAt,
			durableState: runByAssistant.get(m.id)?.state ?? null,
			durableError: runByAssistant.get(m.id)?.errorMessage ?? null
		})),
		durableRun: activeRun
			? {
					id: activeRun.id,
					conversationId: activeRun.conversationId,
					assistantMessageId: activeRun.assistantMessageId,
					cursor: activeRun.cursor,
					status: activeRun.state,
					...snapshotFromRun(activeRun)
				}
			: null
	};
};
