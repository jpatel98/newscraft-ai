import { env } from '$env/dynamic/private';
import { boardData } from '$lib/server/agent/board';
import type { PageServerLoad } from './$types';

// '/' is the newsroom front door. Keep it stable and never redirect to the
// most recent conversation, otherwise the sidebar's "+ new" link bounces
// straight back into the previous thread.
export const load: PageServerLoad = async ({ locals }) => {
	const missionsEnabled = env.ENABLE_MISSIONS === '1';
	if (!locals.user || !missionsEnabled) {
		return {
			board: null,
			boardError: null,
			missionsEnabled
		};
	}

	try {
		return {
			board: await boardData(locals.user.id),
			boardError: null,
			missionsEnabled
		};
	} catch (err) {
		return {
			board: null,
			boardError: err instanceof Error ? err.message : 'Pitch queue unavailable.',
			missionsEnabled
		};
	}
};
