import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const password = 'correct horse battery staple';
const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';

async function ensureTestAccount(request: APIRequestContext) {
	const response = await request.post('/api/e2e/seed', {
		data: { secret: e2eSecret, password },
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`seed account: ${response.status()} ${await response.text()}`);
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
}

async function seedHistory(page: Page, count = 1_000) {
	const response = await page.request.post('/api/e2e/history-fixture', {
		data: { secret: e2eSecret, password, count },
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`seed history: ${response.status()} ${await response.text()}`);
	return (await response.json()) as {
		conversationId: string;
		count: number;
		firstId: string;
		targetId: string;
		latestId: string;
		latestAssistantId: string | null;
		messageIds: string[];
	};
}

async function mutateHistory(
	page: Page,
	input: { conversationId: string; messageId: string; action: 'update' | 'delete'; content?: string }
) {
	const response = await page.request.post('/api/e2e/history-fixture', {
		data: { secret: e2eSecret, password, ...input },
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`mutate history: ${response.status()} ${await response.text()}`);
}

function historyBody(message: string): string {
	return JSON.stringify({
		mode: 'around',
		messages: [
			{
				id: 'history-target',
				role: 'user',
				content: message,
				partial: false,
				createdAt: 500
			}
		],
		pageSize: 1,
		hasOlder: false,
		hasNewer: false,
		targetId: 'history-target',
		gapBefore: false,
		gapAfter: false,
		olderCursor: { createdAt: 500, id: 'history-target' },
		newerCursor: { createdAt: 500, id: 'history-target' }
	});
}

test.describe('bounded conversation history', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('loads a bounded tail, older pages, target gaps, and preserves the anchor after refresh', async ({ page }) => {
		await signIn(page);
		const fixture = await seedHistory(page);
		const apiResponse = await page.request.get(
			`/api/conversations/${fixture.conversationId}/messages?limit=50`
		);
		const apiBody = await apiResponse.body();
		const apiJson = JSON.parse(apiBody.toString('utf8')) as { messages: unknown[] };
		expect(apiResponse.ok()).toBe(true);
		expect(apiJson.messages.length).toBeLessThanOrEqual(50);
		console.log(
			JSON.stringify({
				browserHistoryProbe: true,
				databaseRows: fixture.count,
				initialPageRows: apiJson.messages.length,
				initialPageBytes: apiBody.byteLength
			})
		);

		await page.goto(`/c/${fixture.conversationId}`);
		const thread = page.locator('.thread');
		await expect(thread).toHaveAttribute('data-hydrated', 'true');
		const articles = thread.locator('article[data-message-id]');
		await expect(articles).toHaveCount(50);
		await expect(page.getByRole('button', { name: 'Load older messages' })).toBeVisible();

		await page.getByRole('button', { name: 'Load older messages' }).click();
		await expect(articles).toHaveCount(100);

		await page.goto(`/c/${fixture.conversationId}#m=${encodeURIComponent(fixture.targetId)}`);
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		const target = page.locator(`#m-${fixture.targetId}`);
		await expect(target).toBeVisible();
		await expect(page.getByTestId('history-gap')).toHaveCount(1);
		await target.scrollIntoViewIfNeeded();
		const anchor = await target.boundingBox();
		const threadBox = await thread.boundingBox();
		if (!anchor || !threadBox) throw new Error('target anchor was not measurable');
		const targetCenter = anchor.y + anchor.height / 2;
		const threadCenter = threadBox.y + threadBox.height / 2;
		expect(Math.abs(targetCenter - threadCenter)).toBeLessThan(threadBox.height / 2);

		await page.reload();
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		await expect(target).toBeVisible();
		await expect(page.getByTestId('history-gap')).toHaveCount(1);
		await page.getByRole('button', { name: 'Load older messages' }).click();
		await expect(page.locator('article[data-message-id]')).toHaveCount(151);
	});

	test('retries failed pages and anchors, handles deleted or foreign targets, and drops stale navigation responses', async ({
		page
	}) => {
		await signIn(page);
		const first = await seedHistory(page, 200);
		const second = await seedHistory(page, 20);
		const deletedId = second.messageIds[5];
		await mutateHistory(page, {
			conversationId: second.conversationId,
			messageId: deletedId,
			action: 'delete'
		});

		let failedOlder = true;
		let failedAround = true;
		await page.route('**/api/conversations/*/messages*', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.has('before') && failedOlder) {
				failedOlder = false;
				await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture"}' });
				return;
			}
			if (url.searchParams.has('around') && failedAround) {
				failedAround = false;
				await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture"}' });
				return;
			}
			await route.continue();
		});

		await page.goto(`/c/${first.conversationId}`);
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		await page.getByRole('button', { name: 'Load older messages' }).click();
		await expect(page.getByText("Couldn't load older messages. Try again.")).toBeVisible();
		await page.getByRole('button', { name: 'Retry' }).click();
		await expect(page.locator('article[data-message-id]')).toHaveCount(100);

		const retryTargetId = first.messageIds[50];
		await page.goto(`/c/${first.conversationId}#m=${encodeURIComponent(retryTargetId)}`);
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.getByText("Couldn't load that message. Try again.")).toBeVisible();
		expect(new URL(page.url()).hash).toBe(`#m=${encodeURIComponent(retryTargetId)}`);
		await page.getByRole('button', { name: 'Retry' }).click();
		await expect(page.locator(`#m-${retryTargetId}`)).toBeVisible();

		await page.goto(`/c/${second.conversationId}#m=${encodeURIComponent(deletedId)}`);
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.getByText('That message is no longer available.')).toBeVisible();
		expect(new URL(page.url()).hash).toBe('');

		await page.goto(`/c/${first.conversationId}#m=${encodeURIComponent(second.messageIds[6])}`);
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.getByText('That message is no longer available.')).toBeVisible();
		expect(new URL(page.url()).hash).toBe('');

		let releaseStaleResolve: (() => void) | undefined;
		const staleReady = new Promise<void>((resolve) => {
			releaseStaleResolve = resolve;
		});
		let staleStarted: (() => void) | null = null;
		const staleRequest = new Promise<void>((resolve) => {
			staleStarted = resolve;
		});
		await page.unroute('**/api/conversations/*/messages*');
		await page.route('**/api/conversations/*/messages*', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('around') === first.messageIds[25]) {
				staleStarted?.();
				await staleReady;
				try {
					await route.fulfill({ status: 200, contentType: 'application/json', body: historyBody('stale target') });
				} catch {
					/* Navigation may abort the request before the release. */
				}
				return;
			}
			await route.continue();
		});
		await page.goto(`/c/${first.conversationId}#m=${encodeURIComponent(first.messageIds[25])}`);
		await staleRequest;
		await page.goto(`/c/${second.conversationId}`);
		if (releaseStaleResolve) releaseStaleResolve();
		await expect(page).toHaveURL(new RegExp(`/c/${second.conversationId}$`));
		await expect(page.getByText('That message is no longer available.')).toHaveCount(0);
		await page.unroute('**/api/conversations/*/messages*');
	});

	test('reconciles updated and deleted loaded rows while a stream and paging run', async ({ page }) => {
		await signIn(page);
		const fixture = await seedHistory(page);
		const updatedId = fixture.latestId;
		const deletedId = fixture.messageIds.at(-2) as string;
		await page.addInitScript(() => {
			const originalFetch = window.fetch.bind(window);
			window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				if (!url.includes('/api/chat/runs') || init?.method !== 'POST') return originalFetch(input, init);
				const body =
					'event: agent.meta\ndata: {"conversation_id":"fixture","run_id":"fixture-run"}\n\n' +
					'data: {"choices":[{"delta":{"content":"fixture stream"},"finish_reason":null}]}\n\n' +
					'event: response.completed\ndata: {}\n\n' +
					'data: [DONE]\n\n';
				const bytes = new TextEncoder().encode(body);
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					}
				});
				return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
			};
		});

		await page.goto(`/c/${fixture.conversationId}`);
		await expect(page.locator('.thread')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.locator(`#m-${updatedId}`)).toBeVisible();
		await mutateHistory(page, {
			conversationId: fixture.conversationId,
			messageId: updatedId,
			action: 'update',
			content: 'Updated during refresh reconciliation'
		});
		await mutateHistory(page, {
			conversationId: fixture.conversationId,
			messageId: deletedId,
			action: 'delete'
		});
		await page.getByLabel('Message NewsCraft').fill('Trigger refresh reconciliation');
		await page.getByRole('button', { name: 'Send message' }).click();
		await expect(page.getByText('Updated during refresh reconciliation')).toBeVisible({ timeout: 8_000 });
		await expect(page.locator(`#m-${deletedId}`)).toHaveCount(0);
		await expect(page.locator('article[data-message-id]')).toHaveCount(50);
	});
});
