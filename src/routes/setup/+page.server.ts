import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async () => { throw redirect(303, '/signup'); };
export const actions: Actions = { default: async () => { throw redirect(303, '/signup'); } };
