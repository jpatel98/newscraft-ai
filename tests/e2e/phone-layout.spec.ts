import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery staple';
const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';

async function signUp(page: Page, accountPassword: string) {
	await page.goto('/signup');
	await page.getByLabel('Full name').fill('Phone Tester');
	await page.getByLabel('Email').fill(`phone-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`);
	await page.getByLabel('Password', { exact: true }).fill(accountPassword);
	await page.getByLabel('Confirm password').fill(accountPassword);
	await page.getByRole('button', { name: /create account|sign up/i }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test('on a phone the chat title shares the toolbar row and Use answer opens a bottom sheet', async ({ page }) => {
	// The seed endpoint finds the account by password, so keep it unique to this run.
	const accountPassword = `${password} ${Date.now()}`;
	await signUp(page, accountPassword);
	const seeded = await page.request.post('/api/e2e/seed-conversation', {
		data: {
			secret: e2eSecret,
			password: accountPassword,
			userMessage: 'What did council decide?',
			assistantMessage: 'Council approved the bike lane 18-7.'
		}
	});
	expect(seeded.ok()).toBe(true);
	const { id } = (await seeded.json()) as { id: string };
	await page.goto(`/c/${id}`);
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');

	const cmdbar = (await page.locator('.cmdbar').boundingBox())!;
	const title = (await page.locator('.thread-header .pane__header__title').boundingBox())!;
	expect(title.y).toBeLessThan(cmdbar.y + cmdbar.height);
	expect(title.x).toBeGreaterThanOrEqual(cmdbar.x + cmdbar.width);
	await expect(page.getByRole('button', { name: 'Search threads' })).toBeHidden();

	await page.getByTestId('answer-utility-bar').getByRole('button', { name: /use answer/i }).click();
	const menu = page.getByRole('menu', { name: 'Use answer as' });
	await expect(menu).toBeVisible();
	const sheet = (await menu.boundingBox())!;
	expect(sheet.x).toBe(0);
	expect(sheet.width).toBe(390);
	expect(Math.round(sheet.y + sheet.height)).toBe(844);
	const item = (await menu.getByRole('menuitem', { name: 'Producer brief' }).boundingBox())!;
	expect(item.height).toBeGreaterThanOrEqual(44);

	await page.mouse.click(195, 100);
	await expect(menu).toBeHidden();
});
