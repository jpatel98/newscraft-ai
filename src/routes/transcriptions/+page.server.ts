import { redirect } from '@sveltejs/kit';
import { listTranscripts } from '$lib/server/db/transcripts';
import { getTranscriptionEngine } from '$lib/server/transcripts/engine';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, depends }) => {
	if (!locals.user) throw redirect(303, '/login');
	depends('app:transcriptions');
	return {
		transcripts: await listTranscripts(locals.user.id),
		engineReady: getTranscriptionEngine().configured
	};
};
