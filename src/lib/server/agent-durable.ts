import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
import {
	cancelDurableAgentRun,
	startDurableAgentRun,
	type DurableAgentRunStartRequest
} from '$lib/server/agent/transport';

export { cancelDurableAgentRun, startDurableAgentRun };
export type { DurableAgentRunStartRequest };

/** Authenticate the private owned-agent callback surface; preserve its wire header. */
export function verifyAgentRunCallback(request: Request): boolean {
	const expected = (env.NEWSCRAFT_AGENT_RUN_API_TOKEN || '').trim();
	if (!expected) return false;
	const presented = request.headers.get('x-newscraft-agent-token') || '';
	const expectedBytes = Buffer.from(expected);
	const presentedBytes = Buffer.from(presented);
	return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
}

export function agentRunCallbackConfigured(): boolean {
	return Boolean((env.NEWSCRAFT_AGENT_RUN_API_TOKEN || '').trim());
}
