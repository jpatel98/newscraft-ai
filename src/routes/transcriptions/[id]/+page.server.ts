import { error, redirect } from '@sveltejs/kit';
import { getTranscript, publicTranscript } from '$lib/server/db/transcripts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
	if (!locals.user) throw redirect(303, '/login');
	depends('app:transcript');
	const transcript = await getTranscript(locals.user.id, params.id);
	if (!transcript) throw error(404, 'Transcript not found');
	return { transcript: publicTranscript(transcript) };
};
