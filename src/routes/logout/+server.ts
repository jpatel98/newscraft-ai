import { redirect, type RequestHandler } from '@sveltejs/kit';
import { authBackend } from '$lib/server/auth/backend';
export const POST: RequestHandler = async ({ cookies }) => {
    await (await authBackend()).signOut(cookies);
    throw redirect(303, '/login');
};
