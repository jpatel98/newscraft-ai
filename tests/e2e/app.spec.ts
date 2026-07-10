import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery staple';
// Secret must match E2E_SECRET in playwright.config.ts / the test webserver env.
const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';

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

async function expectChatStartHome(page: Page) {
	await expect(page).toHaveTitle(/New chat · NewsCraft/);
	await expect(
		page.getByRole('heading', { name: 'What should NewsCraft work on?' })
	).toBeVisible();
	await expect(page.locator('[aria-label="Starter prompts"]')).toBeVisible();
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute(
		'placeholder',
		'Ask NewsCraft...'
	);
}

async function expectNoTechnicalLeakage(page: Page) {
	const text = await page.locator('body').innerText();
	expect(text).not.toMatch(
		/Gateway detail|agent gateway|job id|jobId|run id|runId|adapter name|tool trace|tool_call|JSON log/i
	);
	expect(text).not.toMatch(/\b(?:job|run|call|tool)[_-][A-Za-z0-9_-]{6,}\b/);
	expect(text).not.toMatch(/\{\\?"(?:event|tool|job|run|choices|delta)\\?":/);
}

/**
 * Ensure the test account (the well-known test password) exists in the app DB.
 * Calls /api/e2e/seed which is only active when E2E_SECRET is set in the
 * webserver env. Works whether the DB is fresh or pre-seeded.
 */
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

// ── SSE fixture content ──────────────────────────────────────────────────────

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Phase 1: plan-only frames (pending → running states), no answer yet */
const SSE_PLAN_FRAMES =
	sseFrame('agent.plan', {
		source: 'model',
		steps: [
			{ id: 'step_1', tool: 'openai_web_search', label: 'Searching recent coverage', status: 'pending' },
			{ id: 'step_2', tool: 'url_fetch_read', label: 'Reading source page', status: 'pending' }
		]
	}) +
	sseFrame('agent.plan', {
		source: 'model',
		steps: [
			{ id: 'step_1', tool: 'openai_web_search', label: 'Searching recent coverage', status: 'running' },
			{ id: 'step_2', tool: 'url_fetch_read', label: 'Reading source page', status: 'pending' }
		]
	}) +
	sseFrame('agent.plan', {
		source: 'model',
		steps: [
			{ id: 'step_1', tool: 'openai_web_search', label: 'Searching recent coverage', status: 'ok' },
			{ id: 'step_2', tool: 'url_fetch_read', label: 'Reading source page', status: 'running' }
		]
	});

/** Phase 2: answer delta + final plan (all done) + [DONE] */
const SSE_ANSWER_FRAMES =
	`data: ${JSON.stringify({
		id: 'chatcmpl-fixture',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'newsroom-harness',
		choices: [{ index: 0, delta: { content: 'Here is what I found.' }, finish_reason: null }]
	})}\n\n` +
	sseFrame('agent.plan', {
		source: 'model',
		steps: [
			{ id: 'step_1', tool: 'openai_web_search', label: 'Searching recent coverage', status: 'ok' },
			{ id: 'step_2', tool: 'url_fetch_read', label: 'Reading source page', status: 'ok' }
		]
	}) +
	'data: [DONE]\n\n';

/**
 * Intercept /api/chat/stream using a browser-side fetch override.
 *
 * Uses page.addInitScript() to replace window.fetch in the browser before the
 * page loads. The override returns a real ReadableStream (not a buffered body)
 * so the app's readSSE() processes frames as they arrive.
 *
 * Phase 1: plan frames are enqueued immediately when the stream starts.
 * Phase 2: the test calls the returned releaseStream() which calls
 *          page.evaluate() to resolve a Promise inside the browser, causing
 *          the answer frames + [DONE] to be enqueued and the stream closed.
 *
 * This avoids Playwright's route.fulfill() limitation (which delivers the
 * entire body at once) and gives the test a real mid-stream observation window.
 */
async function interceptChatStreamWithPlanFixture(
	page: Page
): Promise<() => Promise<void>> {
	// Inject the fetch override into every page load. The injected code stores
	// the release resolver on window so page.evaluate() can trigger phase 2.
	await page.addInitScript(
		({ planFrames, answerFrames }: { planFrames: string; answerFrames: string }) => {
			const originalFetch = window.fetch.bind(window);
			window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
				if (!url.includes('/api/chat/stream')) {
					return originalFetch(input, init);
				}

				const encoder = new TextEncoder();
				// window.__sseRelease will be set to a resolve() function by the
				// ReadableStream start() below. page.evaluate() calls it for phase 2.
				(window as Window & { __sseRelease?: () => void }).__sseRelease = undefined;

				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						// Phase 1: enqueue plan frames immediately
						controller.enqueue(encoder.encode(planFrames));

						// Gate: wait until page.evaluate calls window.__sseRelease()
						const releasePromise = new Promise<void>((resolve) => {
							(window as Window & { __sseRelease?: () => void }).__sseRelease = resolve;
						});

						releasePromise.then(() => {
							// Phase 2: enqueue answer frames then close the stream
							controller.enqueue(encoder.encode(answerFrames));
							controller.close();
						});
					}
				});

				return new Response(stream, {
					status: 200,
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache'
					}
				});
			};
		},
		{ planFrames: SSE_PLAN_FRAMES, answerFrames: SSE_ANSWER_FRAMES }
	);

	// Return a function the test calls to trigger phase 2 (deliver answer frames)
	return async () => {
		await page.evaluate(() => {
			(window as Window & { __sseRelease?: () => void }).__sseRelease?.();
		});
		// Give the browser time to process the answer frames and re-render
		await page.waitForTimeout(300);
	};
}

test.describe.serial('NewsCraft app shell', () => {
	test.beforeAll(async ({ request }) => {
		// Provision the test account so every test in this suite can sign in.
		// Works whether the database is brand-new or already has accounts.
		await ensureTestAccount(request);
	});

	test('boots a first account, protects routes, and signs back in safely', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await page.goto('/');
		const landingURL = page.url();

		if (/\/setup$/.test(landingURL)) {
			// ── Fresh-database path ──────────────────────────────────────────────
			// The /api/e2e/seed call above created the test account as the first
			// account, so /setup redirects to / now.  This branch only fires when
			// the seed endpoint raced with a genuinely empty database — handle it
			// defensively by verifying setup-page elements then redirecting.
			await expect(page).toHaveTitle(/Set up account/);
			await expect(page.getByRole('heading', { name: 'Create the first account.' })).toBeVisible();
			await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
			await expect(page.getByLabel('Current access password')).toHaveCount(0);

			// Validate form: empty submit shows required error
			await page.getByRole('button', { name: 'Create account' }).click();
			await expect
				.poll(() =>
					page.getByLabel('Password', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.valueMissing)
				)
				.toBe(true);

			// Validate form: password too short
			await page.getByLabel('Password', { exact: true }).fill('short');
			await page.getByLabel('Confirm password').fill('short');
			await page.getByRole('button', { name: 'Create account' }).click();
			await expect
				.poll(() =>
					page.getByLabel('Password', { exact: true }).evaluate((el: HTMLInputElement) => el.validity.tooShort)
				)
				.toBe(true);

			// Validate form: passwords must match
			await page.getByLabel('Password', { exact: true }).fill(password);
			await page.getByLabel('Confirm password').fill('different password');
			await page.getByRole('button', { name: 'Create account' }).click();
			await expect(page.getByText('passwords do not match')).toBeVisible();

			// Actually create the account (test password was already seeded — this
			// would conflict; use a second different password for this form submit
			// since the seeded account holds the test password already).
			// Because the seed already created the account, /setup redirected to /login.
			// This branch is a safety net; if we're here it means the seed was a no-op
			// on an actually empty DB, so creating the account via form works fine.
			await page.getByLabel('Password', { exact: true }).fill(password);
			await page.getByLabel('Confirm password').fill(password);
			await page.getByRole('button', { name: 'Create account' }).click();
			await expect(page).toHaveURL(/\/$/);
			await expectChatStartHome(page);
		} else {
			// ── Pre-seeded-database path ─────────────────────────────────────────
			// Accounts already exist; the app redirects to / (if logged in) or
			// /login (if not). Verify the home or login page looks correct.
			if (/\/login/.test(landingURL)) {
				await expect(page).toHaveTitle(/Sign in/i);
				await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
				await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
				// /setup must not be accessible when accounts exist
				await page.goto('/setup');
				await expect(page).toHaveURL(/\/(login)?$/);
			} else {
				await expectChatStartHome(page);
			}
		}

		// ── Route protection: always applies ────────────────────────────────
		// Sign out and confirm protected routes redirect to /login.
		await page.request.post('/logout');
		await page.goto('/settings');
		await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
		await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
		await expect(page.getByLabel('Password', { exact: true })).toBeFocused();

		// Wrong-password rejection
		await page.getByLabel('Password', { exact: true }).fill('wrong password');
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByText('invalid password')).toBeVisible();

		// Open-redirect protection
		await page.goto('/login?next=https://evil.test/phish');
		await page.getByLabel('Password', { exact: true }).fill(password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/$/);
		await expectChatStartHome(page);
		expect(problems).toEqual([]);
	});

	test('tracks a starter prompt into chat without exposing internals', async ({
		page
	}) => {
		const problems = await collectPageProblems(page);

		await signIn(page);
		await expectChatStartHome(page);

		const message = 'Track latest Toronto housing stories and summarize the newest reliable coverage.';
		await page.getByRole('button', { name: message }).click();
		await expect(page.getByLabel('Message NewsCraft')).toHaveValue(message);
		await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await page.getByRole('button', { name: 'Send message' }).click();

		await expect(page).toHaveURL(/\/c\/[^/]+$/);
		await expect(page.getByText(message)).toBeVisible();
		await expect(page.getByText(/couldn't reach the research service/i)).toBeVisible();
		await expect(page.getByLabel('Message NewsCraft')).toBeVisible();

		await page.getByRole('button', { name: 'Toggle sidebar' }).click();
		await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
		await expect(page.getByText('Untitled thread').first()).toBeVisible();
		await expectNoTechnicalLeakage(page);
		expect(problems).toEqual([]);
	});

	test('keeps the primary flow usable on a mobile viewport', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await page.setViewportSize({ width: 390, height: 844 });
		await signIn(page);
		await expect(
			page.getByRole('heading', { name: 'What should NewsCraft work on?' })
		).toBeVisible();
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

test.describe('plan timeline UI', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('renders plan steps from agent.plan SSE frames and collapses when answer streams', async ({
		page
	}) => {
		const problems = await collectPageProblems(page);

		await signIn(page);

		// Create a conversation pre-seeded with a prior user+assistant exchange via
		// the e2e helper endpoint. This is critical: after the intercepted stream
		// ends and `invalidateAll()` re-fetches the page data, the conversation will
		// have these seeded messages, keeping `lastAssistantId` non-null so
		// PlanTimeline stays mounted in Thread.svelte.
		//
		// The seeded assistant message text matches the SSE fixture's answer so the
		// answer text check passes both during and after the stream overlay.
		const seedRes = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'What are the top stories in Canada today?',
				assistantMessage: 'Here is what I found.'
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!seedRes.ok()) throw new Error(`seed-conversation: ${seedRes.status()} ${await seedRes.text()}`);
		const { id: convId } = (await seedRes.json()) as { id: string };

		// Install the browser-side fetch override BEFORE navigating to the thread.
		// This replaces window.fetch so the real /api/chat/stream is never hit.
		// Phase 1 (plan frames) streams immediately; phase 2 (answer) is held
		// until we call releaseStream().
		const releaseStream = await interceptChatStreamWithPlanFixture(page);

		// Navigate to the thread. The thread already shows the 2 seeded messages.
		await page.goto(`/c/${convId}`);
		await expect(page).toHaveURL(/\/c\/[^/]+$/);

		// The seeded messages should be visible in the thread before any new send
		const userMessage = 'What are the top stories in Canada today?';
		await expect(page.getByText(userMessage).first()).toBeVisible();
		await expect(page.getByText('Here is what I found.').first()).toBeVisible();

		// Send a NEW message from the thread composer (the plan-timeline test prompt)
		const newMessage = 'Follow-up: any updates since yesterday?';
		await page.getByLabel('Message NewsCraft').fill(newMessage);
		await page.getByRole('button', { name: 'Send message' }).click();

		// The new user message should appear in the overlay
		await expect(page.getByText(newMessage)).toBeVisible();

		// ── Phase 1 window ───────────────────────────────────────────────────────
		// The fetch override has delivered plan frames but is holding the stream
		// open. The app's readSSE() has processed the plan frames, so:
		//   • plan-timeline renders and is EXPANDED (hasAssistantOutput = false)
		//   • the answer text has NOT yet appeared
		// This is the mid-stream state we want to verify.
		await expect(page.locator('[data-testid="plan-timeline"]')).toBeVisible({
			timeout: 5_000
		});
		// Steps are visible because the timeline is expanded (answer not yet arrived)
		const steps = page.locator('[data-testid="plan-step"]');
		await expect(steps).toHaveCount(2, { timeout: 3_000 });

		// Human labels — not tool names — should appear in the expanded steps
		await expect(page.getByText('Searching recent coverage')).toBeVisible();
		await expect(page.getByText('Reading source page')).toBeVisible();

		// ── Phase 2: release answer ──────────────────────────────────────────────
		// Trigger phase 2 in the browser: answer delta + [DONE] are enqueued and
		// the ReadableStream is closed. chat.hasAssistantOutput becomes true, which
		// collapses the plan-timeline.
		await releaseStream();

		// After releasing: the stream ends, invalidateAll() re-fetches page data.
		// The conversation has the seeded messages so Thread still has messages,
		// lastAssistantId stays non-null, and PlanTimeline stays mounted.
		// The timeline must now be collapsed (hasAssistantOutput = true).
		await expect(page.locator('ol.plan-timeline__steps')).toHaveCount(0, { timeout: 5_000 });

		// The collapsed summary must still be visible
		await expect(page.locator('[data-testid="plan-timeline"]')).toBeVisible({ timeout: 3_000 });

		// The seeded answer text is visible as a persisted message after invalidateAll
		await expect(page.getByText('Here is what I found.').first()).toBeVisible({ timeout: 5_000 });

		// Toggle expand and verify steps reappear
		await page.locator('[data-testid="plan-timeline"] button').click();
		await expect(steps).toHaveCount(2, { timeout: 3_000 });

		// Verify human labels still showing after manual expand
		await expect(page.getByText('Searching recent coverage')).toBeVisible();
		await expect(page.getByText('Reading source page')).toBeVisible();

		// Tool names must NOT appear in the UI (no technical leakage)
		const bodyText = await page.locator('body').innerText();
		expect(bodyText).not.toMatch(/openai_web_search|url_fetch_read/i);

		await expectNoTechnicalLeakage(page);
		expect(problems).toEqual([]);
	});
});

test.describe('persisted answer sources', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('renders sanitized source receipts after reloading a conversation', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await signIn(page);

		const seedRes = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'What is the latest on the Bank of Canada?',
				assistantMessage:
					'The Bank of Canada held its policy rate steady according to an inline citation [already linked](https://example.com/already-linked).',
				assistantToolCalls: {
					version: 1,
					tools: [{ id: 'call_internal_123456', name: 'openai_web_search', status: 'ok' }],
					sources: [
						{
							id: 'source_internal_1',
							url: 'https://example.com/already-linked',
							title: 'Already linked source',
							domain: 'example.com',
							status: 'used',
							firstSeenAt: 1000,
							lastSeenAt: 1100,
							used: true
						},
						{
							id: 'source_internal_2',
							url: 'https://user:pass@news.example.com/story?token=private&utm_source=e2e#section',
							title: 'Reuters Canada update',
							domain: 'news.example.com',
							status: 'read',
							firstSeenAt: 1200,
							lastSeenAt: 1300,
							used: true
						},
						{
							id: 'source_internal_3',
							url: 'https://internal.example.com/source',
							title: 'openai_web_search',
							domain: 'internal.example.com',
							status: 'used',
							firstSeenAt: 1300,
							lastSeenAt: 1400,
							used: true
						},
						{
							id: 'source_internal_4',
							url: 'javascript:alert(1)',
							title: 'Invalid source',
							domain: 'bad.example',
							status: 'used',
							firstSeenAt: 1400,
							lastSeenAt: 1500,
							used: true
						}
					]
				}
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!seedRes.ok()) throw new Error(`seed-conversation: ${seedRes.status()} ${await seedRes.text()}`);
		const { id: convId } = (await seedRes.json()) as { id: string };

		await page.goto(`/c/${convId}`);
		await expect(page.getByText('The Bank of Canada held its policy rate steady')).toBeVisible();

		const disclosure = page.locator('[data-testid="message-sources"]').first();
		await expect(disclosure).toBeVisible();
		await disclosure.locator('summary').click();
		await expect(disclosure.getByRole('link', { name: 'Reuters Canada update' })).toHaveAttribute(
			'href',
			'https://news.example.com/story'
		);
		await expect(disclosure.getByRole('link', { name: 'internal.example.com' })).toBeVisible();
		await expect(disclosure.getByRole('link', { name: 'Already linked source' })).toHaveCount(0);

		let disclosureText = await disclosure.innerText();
		expect(disclosureText).not.toMatch(/openai_web_search|call_internal|source_internal|javascript|token=|user:pass/i);

		await page.reload();
		await expect(page.getByText('The Bank of Canada held its policy rate steady')).toBeVisible();
		const reloadedDisclosure = page.locator('[data-testid="message-sources"]').first();
		await expect(reloadedDisclosure).toBeVisible();
		await reloadedDisclosure.locator('summary').click();
		await expect(reloadedDisclosure.getByRole('link', { name: 'Reuters Canada update' })).toHaveAttribute(
			'href',
			'https://news.example.com/story'
		);

		disclosureText = await reloadedDisclosure.innerText();
		expect(disclosureText).not.toMatch(/openai_web_search|call_internal|source_internal|javascript|token=|user:pass/i);

		await expectNoTechnicalLeakage(page);
		expect(problems).toEqual([]);
	});
});
