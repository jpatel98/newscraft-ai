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

test('on a phone the story ledger is a bottom sheet you open from the peek bar and swipe to check', async ({ page }) => {
	const accountPassword = `${password} ledger ${Date.now()}`;
	await signUp(page, accountPassword);
	const seeded = await page.request.post('/api/e2e/seed-conversation', {
		data: {
			secret: e2eSecret,
			password: accountPassword,
			userMessage: 'What did council decide?',
			assistantMessage: 'Council approved the bike lane 18-7.'
		}
	});
	const { id } = (await seeded.json()) as { id: string };

	const claim = {
		id: 'claim-1',
		claim: 'Construction starts in spring',
		status: 'reported',
		attributed_to: 'Mayor',
		citations: [],
		date: '2026-10-11',
		needs_check: true,
		updated_at: '2026-10-16T00:00:00.000Z'
	};
	const patches: unknown[] = [];
	await page.route(`**/api/conversations/${id}/ledger`, (route) =>
		route.fulfill({ json: { claims: [claim] } })
	);
	await page.route(`**/api/conversations/${id}/ledger/claim-1`, async (route) => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		patches.push(body);
		await route.fulfill({ json: { claim: { ...claim, ...body, reviewed_by: 'Phone Tester' } } });
	});

	await page.goto(`/c/${id}`);
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
	const peek = page.getByTestId('story-peek');
	await expect(peek).toContainText('1 to check');
	await peek.click();

	const sheet = page.getByTestId('story-ledger-pane');
	await expect(sheet).toHaveAttribute('data-snap', 'half');
	await expect(peek).toBeHidden();
	// No scrim: the answer above the half sheet stays readable.
	await expect(page.getByText('Council approved the bike lane 18-7.')).toBeVisible();

	await page.getByRole('button', { name: 'Expand story ledger' }).click();
	await expect(sheet).toHaveAttribute('data-snap', 'full');

	const card = (await page.locator('.story-claim').first().boundingBox())!;
	await page.mouse.move(card.x + 30, card.y + 20);
	await page.mouse.down();
	await page.mouse.move(card.x + 90, card.y + 22, { steps: 4 });
	await page.mouse.move(card.x + 170, card.y + 22, { steps: 4 });
	await page.mouse.up();
	await expect.poll(() => patches).toEqual([{ needs_check: false }]);
	await expect(page.getByText('Checked by Phone Tester')).toBeVisible();

	await page.getByRole('button', { name: 'Close story pane' }).click();
	await expect(sheet).toBeHidden();
	await expect(peek).toContainText('1 fact, all checked');
});
