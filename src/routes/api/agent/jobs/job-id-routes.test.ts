import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as jobRoute from './[id]/+server';
import * as pauseRoute from './[id]/pause/+server';
import * as resumeRoute from './[id]/resume/+server';
import * as runRoute from './[id]/run/+server';

const boardMocks = vi.hoisted(() => ({
	deleteAgentJob: vi.fn(),
	listAgentJobs: vi.fn(),
	runJobAction: vi.fn(),
	updateAgentJob: vi.fn()
}));

const dbMocks = vi.hoisted(() => ({
	deleteMissionConfig: vi.fn(),
	getMissionConfig: vi.fn(),
	saveMissionConfig: vi.fn(),
	hideChannelJobId: vi.fn()
}));

const persistedJobMocks = vi.hoisted(() => ({
	clearAgentJobState: vi.fn(),
	stateForAgentJobAction: vi.fn(),
	upsertAgentJobState: vi.fn()
}));

vi.mock('$lib/server/agent/board', () => boardMocks);
vi.mock('$lib/server/db/hidden-channels', () => ({ hideChannelJobId: dbMocks.hideChannelJobId }));
vi.mock('$lib/server/db/missions', () => ({
	deleteMissionConfig: dbMocks.deleteMissionConfig,
	getMissionConfig: dbMocks.getMissionConfig,
	saveMissionConfig: dbMocks.saveMissionConfig
}));
vi.mock('$lib/server/db/agent-jobs', () => persistedJobMocks);

persistedJobMocks.stateForAgentJobAction.mockImplementation((action, job) => {
	if (action === 'run') return 'running';
	if (action === 'pause') return 'paused';
	if (action === 'resume') return 'queued';
	if (action === 'create') return 'queued';
	if (action === 'update' && job?.state === 'running') return 'running';
	if (action === 'update' && job?.state === 'paused') return 'paused';
	return 'queued';
});

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

describe('agent job id route behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		[
			'PATCH',
			() =>
				jobRoute.PATCH({
					locals: { user },
					params: { id: '   ' },
					request: new Request('http://localhost/api/agent/jobs/%20', {
						method: 'PATCH',
						body: JSON.stringify({})
					})
				} as any)
		],
		['DELETE', () => jobRoute.DELETE({ locals: { user }, params: { id: '   ' } } as any)],
		['run', () => runRoute.POST({ locals: { user }, params: { id: '   ' } } as any)],
		['pause', () => pauseRoute.POST({ locals: { user }, params: { id: '   ' } } as any)],
		['resume', () => resumeRoute.POST({ locals: { user }, params: { id: '   ' } } as any)]
	])('rejects blank job ids for %s', async (_label, invoke) => {
		await expect(invoke()).rejects.toMatchObject({ status: 400 });
		expect(boardMocks.runJobAction).not.toHaveBeenCalled();
		expect(boardMocks.updateAgentJob).not.toHaveBeenCalled();
		expect(boardMocks.deleteAgentJob).not.toHaveBeenCalled();
		expect(persistedJobMocks.upsertAgentJobState).not.toHaveBeenCalled();
		expect(persistedJobMocks.clearAgentJobState).not.toHaveBeenCalled();
	});

	it('persists failed state when run action rejects', async () => {
		boardMocks.runJobAction.mockRejectedValue(new Error('execution rejected'));

		await expect(runRoute.POST({ locals: { user }, params: { id: 'job-1' } } as any)).rejects.toMatchObject({
			status: 502
		});

		expect(persistedJobMocks.upsertAgentJobState).toHaveBeenCalledWith('account-1', 'job-1', {
			state: 'running',
			lastError: null,
			lastRunAt: expect.any(Number)
		});
		expect(persistedJobMocks.upsertAgentJobState).toHaveBeenCalledWith('account-1', 'job-1', {
			state: 'failed',
			lastRunAt: expect.any(Number),
			lastError: 'execution rejected'
		});
	});

	it('persists paused state on successful pause action', async () => {
		boardMocks.runJobAction.mockResolvedValue({
			id: 'job-1',
			name: 'Job One',
			scheduleDisplay: '*/10 * * * *',
			state: 'paused',
			enabled: true,
			nextRunAt: null,
			lastRunAt: null,
			lastStatus: null,
			lastError: null,
			prompt: null,
			stateFromAction: 'paused'
		});

		const response = await pauseRoute.POST({ locals: { user }, params: { id: 'job-1' } } as any);
		expect(response).toMatchObject({ status: 200 });
		expect(persistedJobMocks.upsertAgentJobState).toHaveBeenCalledWith('account-1', 'job-1', {
			state: 'paused',
			lastRunId: 'job-1',
			lastRunAt: expect.any(Number)
		});
	});

	it('clears persisted state when deleting a job', async () => {
		boardMocks.deleteAgentJob.mockResolvedValue(undefined);
		dbMocks.deleteMissionConfig.mockResolvedValue(undefined);

		await expect(jobRoute.DELETE({ locals: { user }, params: { id: 'job-1' } } as any)).resolves.toMatchObject({
			status: 200
		});
		expect(persistedJobMocks.clearAgentJobState).toHaveBeenCalledWith('account-1', 'job-1');
	});
});
