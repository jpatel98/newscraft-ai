import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery staple';

async function collectPageProblems(page: Page) {
	const problems: string[] = [];
	page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		const text = msg.text();
		if (/Failed to load resource: the server responded with a status of (400|401|502)/.test(text)) {
			return;
		}
		problems.push(`console: ${text}`);
	});
	return problems;
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
}

test.describe.serial('NewsCraft app shell', () => {
	test('boots a first account, protects routes, and signs back in safely', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await page.goto('/');
		await expect(page).toHaveURL(/\/setup$/);
		await expect(page).toHaveTitle(/Set up account/);
		await expect(page.getByRole('heading', { name: 'Create the first account.' })).toBeVisible();
		await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
		await expect(page.getByLabel('Current access password')).toHaveCount(0);

		await page.getByRole('button', { name: 'Create account' }).click();
		await expect
			.poll(() =>
				page.getByLabel('Password', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.valueMissing)
			)
			.toBe(true);

		await page.getByLabel('Password', { exact: true }).fill('short');
		await page.getByLabel('Confirm password').fill('short');
		await page.getByRole('button', { name: 'Create account' }).click();
		await expect
			.poll(() =>
				page.getByLabel('Password', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.tooShort)
			)
			.toBe(true);

		await page.getByLabel('Password', { exact: true }).fill(password);
		await page.getByLabel('Confirm password').fill('different password');
		await page.getByRole('button', { name: 'Create account' }).click();
		await expect(page.getByText('passwords do not match')).toBeVisible();

		await page.getByLabel('Password', { exact: true }).fill(password);
		await page.getByLabel('Confirm password').fill(password);
		await page.getByRole('button', { name: 'Create account' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('heading', { name: 'Start with a question or task.' })).toBeVisible();

		await page.request.post('/logout');
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
		await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
		await expect(page.getByLabel('Password', { exact: true })).toBeFocused();

		await page.getByLabel('Password', { exact: true }).fill('wrong password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByText('invalid password')).toBeVisible();

		await page.goto('/login?next=https://evil.test/phish');
		await page.getByLabel('Password', { exact: true }).fill(password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expect(page.getByRole('heading', { name: 'Start with a question or task.' })).toBeVisible();
		expect(problems).toEqual([]);
	});

	test('creates a thread from the composer and surfaces gateway failure without crashing', async ({
		page
	}) => {
		const problems = await collectPageProblems(page);

		await signIn(page);

		const message = 'Summarize the top newsroom priorities for the morning.';
		await page.getByLabel('Message NewsCraft').fill(message);
		await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await page.getByRole('button', { name: 'Send message' }).click();

		await expect(page).toHaveURL(/\/c\/[^/]+$/);
		await expect(page.getByText(message)).toBeVisible();
		await expect(page.getByText(/couldn't reach the Hermes gateway/i)).toBeVisible();

		await page.getByRole('button', { name: 'Toggle sidebar' }).click();
		await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
		await expect(page.getByText('Untitled thread').first()).toBeVisible();
		expect(problems).toEqual([]);
	});

	test('keeps the primary flow usable on a mobile viewport', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await page.setViewportSize({ width: 390, height: 844 });
		await signIn(page);
		await expect(page.getByRole('heading', { name: 'Start with a question or task.' })).toBeVisible();
		await expect(page.getByLabel('Message NewsCraft')).toBeVisible();

		await page.getByRole('button', { name: 'Toggle sidebar' }).click();
		const sidebar = page.locator('aside[aria-label="Sidebar"]');
		await expect(sidebar).toBeVisible();
		await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();

		await sidebar.getByRole('button', { name: 'Close sidebar' }).click();
		await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
		expect(problems).toEqual([]);
	});
});
