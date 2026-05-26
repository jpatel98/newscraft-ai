import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateMocks = vi.hoisted(() => ({
	resolveEditorialGate: vi.fn()
}));

vi.mock('$lib/server/agent/gates', () => gateMocks);

import { POST } from './+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

function invoke(params: Record<string, string>, body: unknown, locals: Record<string, unknown> = { user }) {
	return POST({
		locals,
		params,
		request: new Request('http://localhost/api/gates/gate-1/resolve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as any);
}

describe('gate resolve route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('requires auth, a gate id, and a non-empty action', async () => {
		await expect(invoke({ id: 'gate-1' }, { action: 'accept' }, { user: null })).rejects.toMatchObject({
			status: 401
		});
		await expect(invoke({ id: '   ' }, { action: 'accept' })).rejects.toMatchObject({ status: 400 });
		await expect(invoke({ id: 'gate-1' }, { action: '   ' })).rejects.toMatchObject({ status: 400 });
		expect(gateMocks.resolveEditorialGate).not.toHaveBeenCalled();
	});

	it('resolves a gate for the signed-in account', async () => {
		gateMocks.resolveEditorialGate.mockResolvedValue({
			gate: { id: 'gate-1', status: 'resolved' },
			event: { id: 'event-1', kind: 'gate.resolved' }
		});

		const response = await invoke({ id: 'gate-1' }, { action: 'accept', notes: 'Approved.' });
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			ok: true,
			gate: { id: 'gate-1', status: 'resolved' },
			event: { id: 'event-1', kind: 'gate.resolved' }
		});
		expect(gateMocks.resolveEditorialGate).toHaveBeenCalledWith('account-1', 'gate-1', {
			action: 'accept',
			notes: 'Approved.'
		});
	});
});
