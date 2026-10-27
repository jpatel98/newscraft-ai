import { json, type RequestHandler } from '@sveltejs/kit';
import {
	agentSubscriptionResponse,
	parseAgentSubscriptionCursor
} from '$lib/server/agent-subscription';

export const GET: RequestHandler = async ({ request, locals, params, url }) => {
	if (!locals.user) return json({ detail: 'unauthorized' }, { status: 401 });
	const runId = params.id?.trim();
	if (!runId) return json({ detail: 'run id required' }, { status: 400 });
	let afterCursor: number;
	try {
		afterCursor = parseAgentSubscriptionCursor(request, url);
	} catch {
		return json({ detail: 'cursor must be a non-negative integer' }, { status: 400 });
	}
	return agentSubscriptionResponse({ request, accountId: locals.user.id, runId, afterCursor });
};
