import type { RequestHandler } from '@sveltejs/kit';
import { POST as createDurableRun } from '../stream/+server';

/**
 * The durable create route reuses NewsCraft's authenticated chat preparation
 * path. The stream route sees only an internal marker and switches to the
 * database-backed worker path before any request-owned Hermes call.
 */
export const POST: RequestHandler = async (event) => {
	const headers = new Headers(event.request.headers);
	headers.set('x-newscraft-durable-run', '1');
	const request = new Request(event.request, { headers });
	return createDurableRun({ ...event, request });
};
