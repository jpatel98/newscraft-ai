import { error, json, type RequestHandler } from '@sveltejs/kit';
import { listHermesCommands } from '$lib/server/hermes/bridge';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({
		commands: [
			{
				name: 'Reasoning',
				slash: '/reasoning',
				description: 'Set reasoning for this thread: low, medium, high, or default.',
				category: 'Chat',
				argsHint: 'low|medium|high|default',
				kind: 'builtin',
				enabled: true
			},
			...(await listHermesCommands())
		]
	});
};
