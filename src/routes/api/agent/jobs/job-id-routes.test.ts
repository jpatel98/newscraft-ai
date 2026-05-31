import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('$lib/server/agent/board', () => boardMocks);
vi.mock('$lib/server/db/hidden-channels', () => ({ hideChannelJobId: dbMocks.hideChannelJobId }));
vi.mock('$lib/server/db/missions', () => ({
	deleteMissionConfig: dbMocks.deleteMissionConfig,
	getMissionConfig: dbMocks.getMissionConfig,
	saveMissionConfig: dbMocks.saveMissionConfig
}));

import * as jobRoute from './[id]/+server';
import * as pauseRoute from './[id]/pause/+server';
import * as resumeRoute from './[id]/resume/+server';
import * as runRoute from './[id]/run/+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

describe('agent job id route validation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		['PATCH', () => jobRoute.PATCH({
			locals: { user },
			params: { id: '   ' },
			request: new Request('http://localhost/api/agent/jobs/%20', {
				method: 'PATCH',
				body: JSON.stringify({})
			})
		} as any)],
		['DELETE', () => jobRoute.DELETE({ locals: { user }, params: { id: '   ' } } as any)],
		['run', () => runRoute.POST({ locals: { user }, params: { id: '   ' } } as any)],
		['pause', () => pauseRoute.POST({ locals: { user }, params: { id: '   ' } } as any)],
		['resume', () => resumeRoute.POST({ locals: { user }, params: { id: '   ' } } as any)]
	])('rejects blank job ids for %s', async (_label, invoke) => {
		await expect(invoke()).rejects.toMatchObject({ status: 400 });
		expect(boardMocks.runJobAction).not.toHaveBeenCalled();
		expect(boardMocks.updateAgentJob).not.toHaveBeenCalled();
		expect(boardMocks.deleteAgentJob).not.toHaveBeenCalled();
	});
});
