import { beforeEach, describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
	agentFetch: vi.fn(),
	describeGatewayError: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err)))
}));

vi.mock('$lib/server/agent/transport', () => transportMocks);

import { POST } from './+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

describe('agent editor command route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('forwards overview command context to the harness editor command endpoint', async () => {
		transportMocks.agentFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					result: {
						ok: true,
						status: 'completed',
						handled_by: 'Monitor',
						agent: 'beat_monitor'
					}
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);

		const response = await POST({
			locals: { user },
			request: new Request('http://localhost/api/agent/editor-command', {
				method: 'POST',
				body: JSON.stringify({
					command: 'read this: https://example.test/story',
					workspaceId: 'workspace-1',
					storyId: 'story-1',
					jobId: 'job-1',
					targetAgent: 'monitor'
				})
			})
		} as any);

		await expect(response.json()).resolves.toMatchObject({
			result: {
				handled_by: 'Monitor',
				agent: 'beat_monitor'
			}
		});
		expect(transportMocks.agentFetch).toHaveBeenCalledWith('/api/editor-commands', {
			method: 'POST',
			body: JSON.stringify({
				command: 'read this: https://example.test/story',
				workspace_id: 'workspace-1',
				story_id: 'story-1',
				job_id: 'job-1',
				run_id: undefined,
				target_agent: 'monitor'
			})
		});
	});
});
