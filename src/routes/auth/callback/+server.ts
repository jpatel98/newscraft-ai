import { redirect, type RequestHandler } from '@sveltejs/kit';
import { authBackend } from '$lib/server/auth/backend';
export const GET: RequestHandler = async ({ url, cookies }) => {
    const code = url.searchParams.get('code');
    if (code && await (await authBackend()).confirm(code, cookies)) throw redirect(303, '/');
    throw redirect(303, '/login?confirmation=retry');
};
