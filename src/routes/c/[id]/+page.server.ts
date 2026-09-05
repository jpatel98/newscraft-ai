import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	getConversation,
	getConversationActionSummary,
	getLatestMessagesPage,
	getMessageCount
} from '$lib/server/db/conversations';
import {
	getActiveHermesRun,
	listHermesRunStatesForMessages,
	snapshotFromRun
} from '$lib/server/db/hermes-runs';
import { listArtifactSummariesForMessages } from '$lib/server/db/artifacts';
import {
	MESSAGE_PAGE_MAX_BYTES,
	MESSAGE_PAGE_SIZE,
	cursorOf,
	rowsToThreadMessages,
	trimNewestMessages,
	type ThreadMessageView
} from '$lib/server/conversation-history';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convo = await getConversation(locals.user.id, params.id);
	if (!convo) throw error(404, 'not found');
	const [candidateRows, totalCount, activeRun, actionSummary] = await Promise.all([
		getLatestMessagesPage(convo.id, MESSAGE_PAGE_SIZE),
		getMessageCount(convo.id),
		getActiveHermesRun(locals.user.id, convo.id),
		getConversationActionSummary(convo.id)
	]);
	const durableRuns = await listHermesRunStatesForMessages(
		locals.user.id,
		convo.id,
		candidateRows.map((message) => message.id)
	);
	const runByAssistant = new Map(durableRuns.map((run) => [run.assistantMessageId, run]));
	const candidateMessages = rowsToThreadMessages(candidateRows, runByAssistant);
	const messages = trimNewestMessages(candidateMessages, MESSAGE_PAGE_SIZE, MESSAGE_PAGE_MAX_BYTES);
	let artifacts: Awaited<ReturnType<typeof listArtifactSummariesForMessages>> = [];
	try {
		artifacts = await listArtifactSummariesForMessages(
			locals.user.id,
			convo.id,
			messages.map((message) => message.id)
		);
	} catch (cause) {
		// Artifact cards are optional history decoration. Keep the conversation
		// page available when the artifact projection is unavailable during a
		// migration or transient database failure.
		console.warn('NewsCraft artifact summary hydration failed', cause);
	}
	const artifactsByMessage = new Map<string, typeof artifacts>();
	for (const artifact of artifacts) {
		const current = artifactsByMessage.get(artifact.sourceMessageId) ?? [];
		current.push(artifact);
		artifactsByMessage.set(artifact.sourceMessageId, current);
	}
	for (const message of messages) {
		const attached = artifactsByMessage.get(message.id);
		if (attached?.length) message.artifacts = attached;
	}
	const first = messages[0];
	const last = messages[messages.length - 1];
	const actionView = (message: (typeof actionSummary)[keyof typeof actionSummary]): ThreadMessageView | null =>
		message ? rowsToThreadMessages([message], new Map())[0] : null;
	return {
		conversation: { id: convo.id, title: convo.title, updatedAt: convo.updatedAt },
		messages,
		history: {
			pageSize: MESSAGE_PAGE_SIZE,
			totalCount,
			hasOlder: totalCount > messages.length || candidateRows.length > messages.length,
			hasNewer: false,
			olderCursor: first ? cursorOf(first) : null,
			newestCursor: last ? cursorOf(last) : null
		},
		actionSummary: {
			latestUser: actionView(actionSummary.latestUser),
			latestAssistantId: actionSummary.latestAssistant?.id ?? null,
			latestReadyAssistantId: actionSummary.latestReadyAssistant?.id ?? null,
			latestUnfinishedAssistantId: actionSummary.latestUnfinishedAssistant?.id ?? null
		},
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
