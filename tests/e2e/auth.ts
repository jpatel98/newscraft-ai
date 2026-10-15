import { expect, type Page } from '@playwright/test';

const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';

/**
 * Sign in as the seeded test account for `password`. Login needs email and
 * password, so this provisions the account (idempotent) and uses the email
 * the seed endpoint reports.
 */
export async function signInWithPassword(page: Page, password: string) {
	const res = await page.request.post('/api/e2e/seed', {
		data: { secret: e2eSecret, password },
		headers: { 'content-type': 'application/json' }
	});
	if (!res.ok()) throw new Error(`/api/e2e/seed returned ${res.status()}: ${await res.text().catch(() => '')}`);
	const { email } = (await res.json()) as { email: string };
	await page.goto('/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL(/\/$/);
}
