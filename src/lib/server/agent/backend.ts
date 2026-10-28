import { env } from '$env/dynamic/private';
import * as transport from './transport';
import * as durable from '$lib/server/agent-durable';
import type { DurableAgentRunStartRequest, GatewayHealth } from './transport';

/**
 * Everything the app needs from an agent backend. Routes depend on this
 * interface, never on a specific worker, so a backend is swapped by config
 * (NEWSCRAFT_AGENT_BACKEND) and a new one is one more entry in BACKENDS.
 * Every backend emits the public events in @newscraft/shared agent-contract.
 */
export interface AgentBackend {
	readonly id: string;
	/** Readiness of the backend; must not throw. */
	health(): Promise<GatewayHealth>;
	/** Stable per-conversation session identity the backend keys runs by. */
	sessionId(messages: Parameters<typeof transport.deriveSessionId>[0], scope: string): string;
	/** Server-owned tenant key for an account. */
	tenantKey(accountId: string): string;
	buildRunInput: typeof transport.buildAgentRunInput;
	/** Admit a durable run; the backend reports events through the run callback API. Throws AgentDurableOverloadError when full. */
	startRun(input: DurableAgentRunStartRequest): Promise<void>;
	cancelRun(accountId: string, runId: string, traceId?: string): Promise<{ state: string }>;
}

/**
 * The NewsCraft-owned worker (services/agent) reached over NEWSCRAFT_AGENT_URL.
 * Functions resolve at call time so a backend module can be partially mocked in tests.
 */
const ownedWorker: AgentBackend = {
	id: 'owned',
	health: () => transport.gatewayHealth(),
	sessionId: (messages, scope) => transport.deriveSessionId(messages, scope),
	tenantKey: (accountId) => transport.deriveAgentTenantKey(accountId),
	buildRunInput: (...args) => transport.buildAgentRunInput(...args),
	startRun: (input) => durable.startDurableAgentRun(input),
	cancelRun: (accountId, runId, traceId) => durable.cancelDurableAgentRun(accountId, runId, traceId)
};

const BACKENDS: Record<string, AgentBackend> = { owned: ownedWorker };

export const AGENT_BACKEND_IDS = Object.keys(BACKENDS);

/** The configured backend. An unknown id is a configuration error, reported loudly. */
export function agentBackend(id = env.NEWSCRAFT_AGENT_BACKEND): AgentBackend {
	const key = (id || 'owned').trim().toLowerCase();
	const backend = BACKENDS[key];
	if (!backend) {
		throw new Error(`NEWSCRAFT_AGENT_BACKEND must be one of: ${AGENT_BACKEND_IDS.join(', ')} (got "${key}").`);
	}
	return backend;
}
