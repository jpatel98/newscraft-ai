import { and, desc, eq } from 'drizzle-orm';
import type { AgentJob } from '$lib/types';
import { db, ensureDefaultOrganizationForAccount } from './index';
import { agentJobs } from './schema';

export type PersistedJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'paused';
type AgentJobAction = 'create' | 'read' | 'update' | 'run' | 'pause' | 'resume';

export interface AgentJobRuntime {
	id: string;
	accountId: string;
	orgId: string | null;
	state: PersistedJobState;
	lastRunId: string | null;
	lastRunAt: number | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
}

interface PersistedJobUpdate {
	state: PersistedJobState;
	lastRunId?: string | null;
	lastRunAt?: number | null;
	lastError?: string | null;
}

type UpdatableRuntime = Pick<
	AgentJobRuntime,
	'state' | 'lastRunId' | 'lastRunAt' | 'lastError' | 'updatedAt'
>;

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function sanitizeId(value: string | null | undefined): string {
	return (value || '').trim();
}

function missingAgentJobsTable(err: unknown): boolean {
	return (
		err instanceof Error &&
		/(no such table:\s*agent_jobs|relation "agent_jobs" does not exist)/i.test(err.message)
	);
}

function normalizePersistedState(raw: string | null | undefined): PersistedJobState | null {
	if (!raw) return null;
	const state = raw.toLowerCase();
	if (['queued', 'pending', 'scheduled'].includes(state)) return 'queued';
	if (['running', 'in_progress', 'active'].includes(state)) return 'running';
	if (['succeeded', 'completed', 'success', 'done', 'complete'].includes(state)) return 'succeeded';
	if (['failed', 'errored', 'error'].includes(state)) return 'failed';
	if (['paused', 'disabled'].includes(state)) return 'paused';
	return null;
}

export function persistedStateFromAgentJob(job: AgentJob | null | undefined): PersistedJobState {
	return normalizePersistedState(job?.state) ?? 'queued';
}

export function stateForAgentJobAction(
	action: AgentJobAction,
	job: AgentJob | null | undefined,
	enabled: boolean | undefined = undefined
): PersistedJobState {
	const fromJob = normalizePersistedState(job?.state);
	if (fromJob) return fromJob;
	if (action === 'run') return 'running';
	if (action === 'pause') return 'paused';
	if (action === 'resume' || action === 'create') return 'queued';
	if (action === 'update') {
		if (enabled === false) return 'paused';
		if (enabled === true) return 'queued';
	}
	return 'queued';
}

export function applyPersistedStateToJob(job: AgentJob, runtime?: AgentJobRuntime | null): AgentJob {
	if (!runtime || runtime.id !== job.id) return job;
	return {
		...job,
		state: runtime.state,
		lastError: runtime.lastError ?? job.lastError ?? null
	};
}

function sortByNewestFirst(rows: AgentJobRuntime[]): AgentJobRuntime[] {
	return [...rows].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

export async function getAgentJobState(accountId: string, jobId: string): Promise<AgentJobRuntime | null> {
	const id = sanitizeId(jobId);
	const owner = sanitizeId(accountId);
	if (!JOB_ID_RE.test(id) || !owner) return null;
	try {
		const rows = await db
			.select()
			.from(agentJobs)
			.where(and(eq(agentJobs.id, id), eq(agentJobs.accountId, owner)))
			.orderBy(desc(agentJobs.updatedAt))
			.limit(1);
		const [row] = rows as AgentJobRuntime[];
		if (!row) return null;
		return row;
	} catch (err) {
		if (missingAgentJobsTable(err)) return null;
		throw err;
	}
}

export async function listAgentJobStates(accountId: string): Promise<AgentJobRuntime[]> {
	const owner = sanitizeId(accountId);
	if (!owner) return [];
	try {
		const rows = await db.select().from(agentJobs).where(eq(agentJobs.accountId, owner));
		return sortByNewestFirst(rows as AgentJobRuntime[]);
	} catch (err) {
		if (missingAgentJobsTable(err)) return [];
		throw err;
	}
}

export async function upsertAgentJobState(
	accountId: string,
	jobId: string,
	payload: PersistedJobUpdate
): Promise<void> {
	const id = sanitizeId(jobId);
	const owner = sanitizeId(accountId);
	if (!JOB_ID_RE.test(id) || !owner) return;
	const now = Date.now();
	let orgId: string | null = null;
	try {
		orgId = await ensureDefaultOrganizationForAccount(owner);
	} catch (err) {
		if (missingAgentJobsTable(err)) return;
		throw err;
	}

	const update: Partial<UpdatableRuntime> = {
		state: payload.state,
		updatedAt: now
	};
	if (payload.lastRunId !== undefined) update.lastRunId = payload.lastRunId;
	if (payload.lastRunAt !== undefined) update.lastRunAt = payload.lastRunAt;
	if (payload.lastError !== undefined) update.lastError = payload.lastError;

	try {
		await db
			.insert(agentJobs)
			.values({
				id,
				accountId: owner,
				orgId,
				state: update.state,
				lastRunId: payload.lastRunId ?? null,
				lastRunAt: payload.lastRunAt ?? null,
				lastError: payload.lastError ?? null,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: agentJobs.id,
				set: update
			});
	} catch (err) {
		if (!missingAgentJobsTable(err)) throw err;
	}
}

export async function clearAgentJobState(accountId: string, jobId: string): Promise<void> {
	const id = sanitizeId(jobId);
	const owner = sanitizeId(accountId);
	if (!JOB_ID_RE.test(id) || !owner) return;
	try {
		await db.delete(agentJobs).where(and(eq(agentJobs.id, id), eq(agentJobs.accountId, owner)));
	} catch (err) {
		if (!missingAgentJobsTable(err)) throw err;
	}
}

export async function clearAgentJobStates(accountId: string): Promise<void> {
	const owner = sanitizeId(accountId);
	if (!owner) return;
	try {
		await db.delete(agentJobs).where(eq(agentJobs.accountId, owner));
	} catch (err) {
		if (!missingAgentJobsTable(err)) throw err;
	}
}
