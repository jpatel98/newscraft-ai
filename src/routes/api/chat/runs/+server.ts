import type { RequestHandler } from '@sveltejs/kit';
import { POST as createDurableRun } from '../stream/+server';

/**
 * The durable create route reuses NewsCraft's authenticated chat preparation
 * path. Both URLs always use the same durable worker and saved event stream.
 */
export const POST: RequestHandler = async (event) => {
	return createDurableRun(event);
};
