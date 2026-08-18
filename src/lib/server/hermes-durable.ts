import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
import {
	cancelDurableHermesRun,
	startDurableHermesRun,
	type DurableHermesRunStartRequest
} from '$lib/server/agent/transport';

export { cancelDurableHermesRun, startDurableHermesRun };
export type { DurableHermesRunStartRequest };

/** Authenticate only the private Hermes service callback surface. */
export function verifyHermesRunCallback(request: Request): boolean {
	const expected = (env.NEWSCRAFT_HERMES_RUN_API_TOKEN || '').trim();
	if (!expected) return false;
	const presented = request.headers.get('x-newscraft-hermes-token') || '';
	const expectedBytes = Buffer.from(expected);
	const presentedBytes = Buffer.from(presented);
	return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

export function hermesRunCallbackConfigured(): boolean {
	return Boolean((env.NEWSCRAFT_HERMES_RUN_API_TOKEN || '').trim());
}
