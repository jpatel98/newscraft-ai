import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createBackup, listBackups } from '$lib/server/db/maintenance';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const result = await listBackups();
	return json(result, {
		status: result.ok ? 200 : 500,
		headers: NO_STORE
	});
};

export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	const result = await createBackup();
	return json(result, {
		status: result.ok ? 201 : 500,
		headers: NO_STORE
	});
};
