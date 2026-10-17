import { expect, test, type Page } from '@playwright/test';
import { signInWithPassword } from './auth';

const password = 'correct horse battery staple';
const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';
const today = new Date().toISOString().slice(0, 10);

const citations = [
	{ citationNumber: 1, url: 'https://www.tps.ca/media-centre/news-releases/1', publicationDate: today },
	{ citationNumber: 2, url: 'https://www.cbc.ca/news/canada/toronto/1', publicationDate: today },
	{ citationNumber: 3, url: 'https://ca.news.yahoo.com/1', publicationDate: today },
	{ citationNumber: 4, url: 'https://www.cbc.ca/news/canada/toronto/fare', publicationDate: '2025-09-02' },
	{ citationNumber: 5, url: 'https://www.msn.com/en-ca/news/1', publicationDate: today }
];

const claim = (text: string, status: string, cites: number[], extra: Record<string, unknown> = {}) => ({
	claim: text,
	status,
	attributed_to: '',
	citations: cites,
	date: '',
	needs_check: false,
	...extra
});

async function ledgerTurn(page: Page, body: Record<string, unknown>) {
	const response = await page.request.post('/api/e2e/ledger-fixture', {
		data: { secret: e2eSecret, password, citations, ...body },
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`ledger fixture: ${response.status()} ${await response.text()}`);
	return (await response.json()) as { conversationId: string };
}

async function openChat(page: Page, conversationId: string) {
	await page.goto(`/c/${conversationId}`);
	await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
}

const group = (page: Page, label: string) => page.getByTestId('story-ledger-pane').getByRole('region', { name: label });

test('the story pane sorts claims by what can go to air and says how to attribute them', async ({ page }) => {
	await signInWithPassword(page, password);
	const { conversationId } = await ledgerTurn(page, {
		title: 'Bloor crash',
		claims: [
			claim('Police say two people were taken to hospital after the Bloor Street crash', 'reported', [1], { attributed_to: 'Toronto police' }),
			claim('The driver was going twice the speed limit', 'alleged', [2], { attributed_to: 'Toronto police' }),
			claim('The eastbound lanes will stay closed until Friday', 'confirmed', [2]),
			claim('A second vehicle fled the scene', 'confirmed', [3, 5]),
			claim('A TTC adult fare costs $3.30', 'confirmed', [4], { attributed_to: 'TTC' })
		]
	});

	await openChat(page, conversationId);
	await page.getByTestId('story-ledger-button').click();
	const pane = page.getByTestId('story-ledger-pane');
	await expect(pane.getByRole('heading', { name: 'Bloor crash' })).toBeVisible();

	// The official police release backs the hospital claim, whatever the model said.
	await expect(group(page, 'Safe to air')).toContainText('two people were taken to hospital');
	// One CBC story is not confirmation: attribute it, with the phrase spelled out.
	const careful = group(page, 'Attribute carefully');
	await expect(careful).toContainText('eastbound lanes will stay closed');
	await expect(careful).toContainText('Say: “according to CBC News”');
	await expect(careful).toContainText('Say: “Toronto police allege”');
	await expect(careful).toContainText('model said confirmed');
	// Two aggregator copies are not a source at all.
	await expect(group(page, "Don't air yet")).toContainText('A second vehicle fled the scene');
	// A year-old source opens a check on its own.
	await expect(group(page, 'Open checks')).toContainText('needs check: the newest source is old');
	// Chips name the claim's own source, not the thread's newest [n].
	await expect(careful.getByRole('button', { name: 'Open source 2' }).first()).toHaveText('[2] CBC News');
	await expect(pane.getByTestId('story-ledger-changes')).toHaveCount(0);

	// Close (seen), then a later answer changes the story.
	await pane.getByRole('button', { name: 'Close story pane' }).click();
	await ledgerTurn(page, {
		conversationId,
		citations: [...citations, { citationNumber: 6, url: 'https://www.cp24.com/news/crash', publicationDate: today }],
		claims: [claim('Police say two people were taken to hospital after the Bloor Street crash', 'retracted', [6], { attributed_to: 'Toronto police' })]
	});
	await page.getByTestId('story-ledger-button').click();
	const changes = pane.getByTestId('story-ledger-changes');
	await expect(changes).toContainText('Changed since you last looked');
	await expect(changes).toContainText('Retracted');
	await expect(group(page, "Don't air yet")).toContainText('two people were taken to hospital');
	await changes.getByRole('button', { name: 'Mark as seen' }).click();
	await expect(changes).toHaveCount(0);

	// A person clears the stale check by hand; it leaves Open checks.
	const stale = group(page, 'Open checks').getByTestId('story-claim').filter({ hasText: 'TTC adult fare' });
	await stale.getByRole('button', { name: 'Mark checked' }).click();
	await expect(group(page, 'Open checks')).toHaveCount(0);
	await expect(pane.getByTestId('story-claim').filter({ hasText: 'TTC adult fare' })).toContainText('Checked by');
});

test('the story pane fits a phone screen', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await signInWithPassword(page, password);
	const { conversationId } = await ledgerTurn(page, {
		claims: [claim('The driver was going twice the speed limit on a very long stretch of Bloor Street West', 'alleged', [2], { attributed_to: 'Toronto police' })]
	});
	await openChat(page, conversationId);
	await page.getByTestId('story-ledger-button').click();
	await expect(page.getByTestId('story-claim-say')).toHaveText('Say: “Toronto police allege”');
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(overflow).toBeLessThanOrEqual(0);
});

test('the story pane writes a VO from the ledger and says what it changed', async ({ page }) => {
	await signInWithPassword(page, password);
	const { conversationId } = await ledgerTurn(page, {
		claims: [
			claim('The driver was going twice the speed limit', 'alleged', [2], { attributed_to: 'Toronto police' }),
			claim('A second vehicle fled the scene', 'confirmed', [3, 5])
		]
	});
	// The copy model runs on the worker; this test covers the pane, so the route answers with a fixed draft.
	await page.route(`**/api/conversations/${conversationId}/ledger/copy`, (route) =>
		route.fulfill({
			json: { format: 'vo', text: '{VO}\nTORONTO POLICE ALLEGE THAT THE DRIVER WAS GOING TWICE THE SPEED LIMIT.', repaired: 1, dropped: 0, withheld: 1 }
		})
	);
	await openChat(page, conversationId);
	await page.getByTestId('story-ledger-button').click();
	await page.getByTestId('story-write-vo').click();
	const draft = page.getByTestId('story-copy-draft');
	await expect(draft.getByTestId('story-copy-text')).toContainText('TORONTO POLICE ALLEGE THAT');
	await expect(draft).toContainText('Attribution put back in 1 sentence.');
	await expect(draft).toContainText('Leaves out 1 claim not ready for air.');
});
