import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from './+server';

const boardMocks = vi.hoisted(() => ({
	createAgentJob: vi.fn(),
	deleteAllAgentJobs: vi.fn(),
	listAgentJobs: vi.fn()
}));

const missionMocks = vi.hoisted(() => ({
	saveMissionConfig: vi.fn()
}));

const persistedJobMocks = vi.hoisted(() => ({
	applyPersistedStateToJob: vi.fn(),
	clearAgentJobStates: vi.fn(),
	listAgentJobStates: vi.fn(),
	stateForAgentJobAction: vi.fn(),
	upsertAgentJobState: vi.fn()
}));

vi.mock('$lib/server/agent/board', () => boardMocks);
vi.mock('$lib/server/db/missions', () => missionMocks);
vi.mock('$lib/server/db/agent-jobs', () => persistedJobMocks);

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

function job(id: string, state = 'running', enabled = true) {
	return {
		id,
		name: `Job ${id}`,
		description: '',
		prompt: null,
		scheduleDisplay: '*/10 * * * *',
		state,
		enabled,
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		lastDeliveryError: null,
		deliver: null,
		outputFormat: 'markdown'
	};
}

describe('agent jobs routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		persistedJobMocks.listAgentJobStates.mockResolvedValue([]);
		persistedJobMocks.stateForAgentJobAction.mockImplementation((_action, agentJob) => {
			if (agentJob?.state === 'running') return 'running';
			return 'queued';
		});
	});

	it('hydrates list rows from persisted lifecycle states', async () => {
		boardMocks.listAgentJobs.mockResolvedValue([job('job-1', 'running'), job('job-2', 'queued')]);
		persistedJobMocks.listAgentJobStates.mockResolvedValue([
			{
				id: 'job-1',
				accountId: 'account-1',
				orgId: 'org_default',
				state: 'paused',
				lastRunId: null,
				lastRunAt: 100,
				lastError: null,
				createdAt: 1000,
				updatedAt: 2000
			},
			{
				id: 'job-2',
				accountId: 'account-1',
				orgId: 'org_default',
				state: 'succeeded',
				lastRunId: null,
				lastRunAt: 100,
				lastError: 'old error',
				createdAt: 1000,
				updatedAt: 2000
			}
		]);
		persistedJobMocks.applyPersistedStateToJob.mockImplementation(
			(baseJob, persisted) => (persisted ? { ...baseJob, state: persisted.state, lastError: persisted.lastError } : baseJob)
		);

		const response = await GET({ locals: { user } } as any);
		const body = await response.json();

		expect(body.jobs).toMatchObject([
			{ id: 'job-1', state: 'paused', lastError: null },
			{ id: 'job-2', state: 'succeeded', lastError: 'old error' }
		]);
	});

	it('persists state after create route', async () => {
		boardMocks.createAgentJob.mockResolvedValue(job('job-3', 'running'));
		missionMocks.saveMissionConfig.mockResolvedValue(undefined);

		const response = await POST({
			locals: { user },
			request: new Request('http://localhost/api/agent/jobs', {
				method: 'POST',
				body: JSON.stringify({
					name: 'Job Three',
					schedule: '*/10 * * * *',
					prompt: 'Research this',
					sources: []
				})
			})
		} as any);

		expect(response.status).toBe(200);
		expect(persistedJobMocks.upsertAgentJobState).toHaveBeenCalledWith('account-1', 'job-3', {
			state: 'running'
		});
	});

	it('clears all persisted job states only when all job deletes succeed', async () => {
		boardMocks.deleteAllAgentJobs.mockResolvedValue({ deleted: 2, failed: [] });
		await DELETE({ locals: { user } } as any);
		expect(persistedJobMocks.clearAgentJobStates).toHaveBeenCalledWith('account-1');

		boardMocks.deleteAllAgentJobs.mockResolvedValue({ deleted: 1, failed: ['job-2: deny'] });
		vi.clearAllMocks();
		await expect(DELETE({ locals: { user } } as any)).resolves.toMatchObject({ status: 200 });
		expect(persistedJobMocks.clearAgentJobStates).not.toHaveBeenCalled();
	});
});
