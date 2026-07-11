import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery staple';
const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
}

async function ensureTestAccount(request: import('@playwright/test').APIRequestContext) {
	const res = await request.post('/api/e2e/seed', {
		data: { secret: e2eSecret, password },
		headers: { 'content-type': 'application/json' }
	});
	if (!res.ok()) {
		const body = await res.text().catch(() => '');
		throw new Error(`/api/e2e/seed returned ${res.status()}: ${body}`);
	}
}

async function expectSettingsFlow(page: Page) {
	await expect(page.getByRole('heading', { name: 'Account & preferences' })).toBeVisible();
	await expect(page.locator('.settings h2')).toHaveText([
		'Account',
		'Newsroom',
		'Data',
		'Security',
		'Sessions',
		'Danger zone'
	]);

	const settingsText = await page.locator('.settings').innerText();
	expect(settingsText).not.toMatch(
		/Agent|newsroom-agent|Installed skills|Supporting files|filesystem|JSONL|gateway|adapter|provider|tool/i
	);
	expect(settingsText).not.toMatch(/\b(?:job|run|call|tool)[_-][A-Za-z0-9_-]{6,}\b/i);

	const overflow = await page.locator('.settings').evaluate((el) => ({
		clientWidth: el.clientWidth,
		scrollWidth: el.scrollWidth
	}));
	expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.describe('settings page', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('prioritizes account, data, security, and sessions without internals', async ({
		page
	}) => {
		await signIn(page);
		await page.goto('/settings');

		await expectSettingsFlow(page);

		const wipeButton = page.getByRole('button', { name: 'Wipe everything' });
		await expect(wipeButton).toBeDisabled();
		await page.getByLabel(/Type WIPE-EVERYTHING/).fill('WIPE-EVERYTHING');
		await expect(wipeButton).toBeEnabled();
		await wipeButton.click();
		await expect(page.getByRole('dialog', { name: 'Wipe everything?' })).toBeVisible();
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('dialog', { name: 'Wipe everything?' })).toHaveCount(0);
	});

	test('stays usable on a mobile viewport', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await signIn(page);
		await page.goto('/settings');

		await expectSettingsFlow(page);
		await expect(page.getByRole('button', { name: 'Create setup link' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Download conversations' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	});
});
