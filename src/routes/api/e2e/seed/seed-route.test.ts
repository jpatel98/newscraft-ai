import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
	dev: false,
	env: { E2E_SECRET: 'synthetic-fixture-secret' },
	findAccount: vi.fn(),
	createAccount: vi.fn()
}));

vi.mock('$app/environment', () => ({ get dev() { return fixture.dev; } }));
vi.mock('$env/dynamic/private', () => ({ env: fixture.env }));
vi.mock('$lib/server/db/accounts', () => ({
	findAccountByPassword: fixture.findAccount,
	createPasswordOnlyAccount: fixture.createAccount
}));

import { POST } from './+server';

describe('development-only test account seeding', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fixture.dev = false;
		fixture.env.E2E_SECRET = 'synthetic-fixture-secret';
		fixture.findAccount.mockResolvedValue(undefined);
		fixture.createAccount.mockResolvedValue({ email: 'synthetic@example.invalid' });
	});

	it('rejects production before reading any body or accessing accounts, even with a configured test secret', async () => {
		const parse = vi.fn();
		await expect(POST({ request: { json: parse } } as never)).rejects.toMatchObject({ status: 404 });
		expect(parse).not.toHaveBeenCalled();
		expect(fixture.findAccount).not.toHaveBeenCalled();
		expect(fixture.createAccount).not.toHaveBeenCalled();
	});

	it('rejects development without an explicit test secret before parsing', async () => {
		fixture.dev = true;
		fixture.env.E2E_SECRET = '';
		const parse = vi.fn();
		await expect(POST({ request: { json: parse } } as never)).rejects.toMatchObject({ status: 404 });
		expect(parse).not.toHaveBeenCalled();
	});

	it('rejects the wrong development secret without accessing accounts', async () => {
		fixture.dev = true;
		const request = new Request('http://127.0.0.1/api/e2e/seed', {
			method: 'POST', body: JSON.stringify({ secret: 'wrong', password: 'synthetic-password' })
		});
		await expect(POST({ request } as never)).rejects.toMatchObject({ status: 403 });
		expect(fixture.findAccount).not.toHaveBeenCalled();
		expect(fixture.createAccount).not.toHaveBeenCalled();
	});

	it('retains authorized disposable development account creation', async () => {
		fixture.dev = true;
		const request = new Request('http://127.0.0.1/api/e2e/seed', {
			method: 'POST', body: JSON.stringify({ secret: fixture.env.E2E_SECRET, password: 'synthetic-password' })
		});
		const response = await POST({ request } as never);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, created: true, email: 'synthetic@example.invalid' });
		expect(fixture.createAccount).toHaveBeenCalledExactlyOnceWith('synthetic-password');
	});
});
