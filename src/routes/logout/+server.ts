import { redirect, type RequestHandler } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';

export const POST: RequestHandler = async ({ cookies }) => {
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	throw redirect(303, '/login');
};
