import { error, json, type RequestHandler } from '@sveltejs/kit';
import { boardData } from '$lib/server/hermes/board';

export const GET: RequestHandler = async ({ locals, setHeaders }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	setHeaders({ 'cache-control': 'no-store' });
	return json(await boardData());
};
