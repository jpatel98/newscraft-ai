import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async () => { throw error(410, 'Use email sign-up to create your account.'); };
export const actions: Actions = { default: async () => { throw error(410, 'Use email sign-up to create your account.'); } };
