import { env } from '$env/dynamic/private';
import { boardData } from '$lib/server/agent/board';
import { ensureDemoGate, listEditorialEvents } from '$lib/server/agent/gates';
import type { BoardData, EditorialEvent, EditorialGate } from '$lib/types';
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
			gates: [],
			gateEvents: [],
			gateError: null,
			missionsEnabled
		};
	}

	let board: BoardData | null = null;
	let boardError: string | null = null;
	let gates: EditorialGate[] = [];
	let gateEvents: EditorialEvent[] = [];
	let gateError: string | null = null;

	try {
		board = await boardData(locals.user.id);
	} catch (err) {
		boardError = err instanceof Error ? err.message : 'Pitch queue unavailable.';
	}

	try {
		gates = await ensureDemoGate(locals.user.id);
		gateEvents = await listEditorialEvents(locals.user.id);
	} catch (err) {
		gateError = err instanceof Error ? err.message : 'Gate queue unavailable.';
	}

	return {
		board,
		boardError,
		gates,
		gateEvents,
		gateError,
		missionsEnabled
	};
};
