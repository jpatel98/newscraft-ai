import { error, type RequestHandler } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/authorization';
export const POST: RequestHandler = async ({ locals }) => {
    requireAdmin(locals.user);
    throw error(410, 'Account administration is managed through Supabase Auth.');
};
