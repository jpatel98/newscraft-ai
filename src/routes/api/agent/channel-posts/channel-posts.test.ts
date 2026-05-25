import { beforeEach, describe, expect, it, vi } from 'vitest';

const ingestMocks = vi.hoisted(() => ({
	getMissionAccountId: vi.fn(),
	upsertMissionReport: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: { NEWSROOM_UI_INGEST_KEY: 'ingest-secret' } }));
vi.mock('$lib/server/db/missions', () => ({
	getMissionAccountId: ingestMocks.getMissionAccountId
}));
vi.mock('$lib/server/db/mission-reports', () => ({
	upsertMissionReport: ingestMocks.upsertMissionReport
}));

import { POST } from './+server';

function request(body: unknown) {
	return POST({
		request: new Request('http://localhost/api/agent/channel-posts', {
			method: 'POST',
			headers: {
				authorization: 'Bearer ingest-secret',
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		})
	} as any);
}

describe('agent channel-post ingest', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects reports when no body or markdown jobId is present', async () => {
		await expect(
			request({
				responseMarkdown: '# Report\n\nNo job metadata here.'
			})
		).rejects.toMatchObject({ status: 400 });

		expect(ingestMocks.getMissionAccountId).not.toHaveBeenCalled();
		expect(ingestMocks.upsertMissionReport).not.toHaveBeenCalled();
	});

	it('accepts reports with a parsed markdown jobId', async () => {
		ingestMocks.getMissionAccountId.mockResolvedValue('account-1');

		const response = await request({
			responseMarkdown: `# Cron Job: Politics\n\n**Job ID:** mission-1\n**Run Time:** 2026-05-25 01:30:00\n\n## Response\n\n# Brief\n\nLead item.`
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(ingestMocks.getMissionAccountId).toHaveBeenCalledWith('mission-1');
		expect(ingestMocks.upsertMissionReport).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: 'account-1',
				missionId: 'mission-1',
				missionName: 'Politics'
			})
		);
	});
});
