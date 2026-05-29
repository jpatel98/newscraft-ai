import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '$lib/types';

const mocks = vi.hoisted(() => ({
	agentFetch: vi.fn(),
	listHiddenChannelJobIds: vi.fn(),
	listMissionConfigs: vi.fn(),
	overlayMissionConfigs: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: { NEWSROOM_CRON_OUTPUT_DIR: '/tmp/newscraft-empty' } }));

vi.mock('./transport', () => ({
	agentFetch: mocks.agentFetch,
	describeGatewayError: (err: unknown) => (err instanceof Error ? err.message : String(err))
}));

vi.mock('$lib/server/db/hidden-channels', () => ({
	listHiddenChannelJobIds: mocks.listHiddenChannelJobIds,
	unhideChannelJobId: vi.fn()
}));

vi.mock('$lib/server/db/mission-reports', () => ({
	clearAllMissionReports: vi.fn(),
	deleteMissionReportsByMissionIds: vi.fn(),
	listMissionReports: vi.fn(async () => []),
	listMissionReportSummaries: vi.fn(async () => []),
	renameMissionReportsForMission: vi.fn(),
	upsertMissionReport: vi.fn()
}));

vi.mock('$lib/server/db/missions', () => ({
	clearAllMissionConfigs: vi.fn(),
	deleteMissionConfig: vi.fn(),
	getMissionConfig: vi.fn(),
	listMissionConfigs: mocks.listMissionConfigs,
	overlayMissionConfigs: mocks.overlayMissionConfigs
}));

import { boardData } from './board';

describe('agent board data', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listHiddenChannelJobIds.mockResolvedValue([]);
		mocks.listMissionConfigs.mockImplementation(async (_accountId: string, missionIds: string[]) => {
			const configs = new Map();
			if (missionIds.includes('job-owned')) {
				configs.set('job-owned', {
					missionId: 'job-owned',
					basePrompt: 'Scan owned beat.',
					description: '',
					outputFormat: 'markdown',
					sources: []
				});
			}
			return configs;
		});
		mocks.overlayMissionConfigs.mockImplementation(async (_accountId: string, jobs: AgentJob[]) => jobs);
	});

	it('filters global run responses to the account-owned jobs', async () => {
		mocks.agentFetch.mockImplementation(async (input: string, init?: RequestInit) => {
			if (input.startsWith('/api/jobs?')) {
				return Response.json({
					jobs: [
						{
							id: 'job-owned',
							workspace_id: 'account:editor-1',
							name: 'Owned Watch',
							prompt: 'Scan owned beat.',
							schedule: 'every 60m',
							enabled: true,
							runs: [{ id: 'embedded-owned', job_id: 'job-owned', status: 'running' }]
						},
						{
							id: 'job-other',
							workspace_id: 'account:other',
							name: 'Other Watch',
							prompt: 'Scan other beat.',
							schedule: 'every 60m',
							enabled: true,
							runs: [{ id: 'embedded-other', job_id: 'job-other', status: 'running' }]
						}
					]
				});
			}
			if (input.startsWith('/api/runs?')) {
				expect(input).toContain(`job_ids=${encodeURIComponent('job-owned')}`);
				return Response.json({
					runs: [
						{ id: 'global-owned', job_id: 'job-owned', status: 'running' },
						{ id: 'global-other', job_id: 'job-other', status: 'running' }
					]
				});
			}
			if (input === '/api/jobs/job-owned' && init?.method === 'PATCH') {
				return Response.json({ ok: true });
			}
			throw new Error(`Unexpected fetch ${input}`);
		});

		const board = await boardData('editor-1', { includeResponseMarkdown: false });

		expect(board.runs?.map((run) => run.id).sort()).toEqual(['embedded-owned', 'global-owned']);
		expect(board.runs?.some((run) => run.jobId === 'job-other')).toBe(false);
	});
});
