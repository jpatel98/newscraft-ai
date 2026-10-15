import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery staple';

async function signUp(page: Page) {
	await page.goto('/signup');
	await page.getByLabel('Full name').fill('Not Found Tester');
	await page.getByLabel('Email').fill(`not-found-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('button', { name: /create account|sign up/i }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
}

async function expectClearOfCommandBar(page: Page) {
	const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
	const cmdbar = await page.locator('.cmdbar').boundingBox();
	expect(heading).not.toBeNull();
	expect(cmdbar).not.toBeNull();
	expect(heading!.y).toBeGreaterThanOrEqual(cmdbar!.y + cmdbar!.height);
}

test.describe('not-found page', () => {
	for (const viewport of [
		{ name: 'desktop', width: 1440, height: 900 },
		{ name: 'phone', width: 390, height: 844 }
	]) {
		test(`a bad chat link offers a way back on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await signUp(page);
			const res = await page.goto('/c/00000000-0000-4000-8000-000000000000');
			expect(res?.status()).toBe(404);
			await expect(page.getByRole('heading', { name: 'Chat not found' })).toBeVisible();
			await expectClearOfCommandBar(page);
			await page.getByRole('link', { name: 'Back to chats' }).click();
			await expect(page).toHaveURL(/\/$/);
		});
	}

	test('an unknown page says page not found', async ({ page }) => {
		await signUp(page);
		await page.goto('/no-such-page');
		await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Back to chats' })).toHaveAttribute('href', '/');
	});
});
