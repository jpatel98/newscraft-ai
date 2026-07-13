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
		if (/Failed to load resource:.*status of 401 \(Unauthorized\)/.test(text)) return;
		problems.push(`console: ${text}`);
	});
	return problems;
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
}

async function expectChatStartHome(page: Page) {
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
	await expect(page).toHaveTitle(/New chat · NewsCraft/);
	await expect(page.getByRole('heading', { name: 'What are you working on?' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Start with a newsroom task' })).toBeVisible();
	await expect(page.locator('[aria-label="Starter prompts"]')).toBeVisible();
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute(
		'placeholder',
		'Ask about a story, source, or newsroom task...'
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

async function seedConversation(
	page: Page,
	input: { userMessage: string; assistantMessage: string; title?: string }
): Promise<string> {
	const res = await page.request.post('/api/e2e/seed-conversation', {
		data: {
			secret: e2eSecret,
			password,
			userMessage: input.userMessage,
			assistantMessage: input.assistantMessage
		},
		headers: { 'content-type': 'application/json' }
	});
	if (!res.ok()) throw new Error(`seed-conversation: ${res.status()} ${await res.text()}`);
	const { id } = (await res.json()) as { id: string };
	if (input.title) {
		const patch = await page.request.patch(`/api/conversations/${id}`, {
			data: { title: input.title },
			headers: { 'content-type': 'application/json' }
		});
		if (!patch.ok()) throw new Error(`rename conversation: ${patch.status()} ${await patch.text()}`);
	}
	return id;
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

async function installAnswerActionStreamFixture(page: Page) {
	const answerFrame = `data: ${JSON.stringify({
		id: 'chatcmpl-answer-action',
		object: 'chat.completion.chunk',
		created: 0,
		model: 'newsroom-harness',
		choices: [
			{
				index: 0,
				delta: { content: 'Formatted answer with inherited evidence [1].' },
				finish_reason: null
			}
		]
	})}\n\n`;
	const citationFrame = sseFrame('agent.citations', {
		citations: [
			{
				citationNumber: 1,
				title: 'FIFA match schedule',
				url: 'https://inside.fifa.com/match-centre',
				domain: 'inside.fifa.com',
				publicationDate: '2026-07-10',
				sourceType: 'official',
				supportingExcerpt: 'The confirmed match begins at 19:00 local time.'
			}
		]
	});
	await page.addInitScript(({ answerFrame, citationFrame }) => {
		const originalFetch = window.fetch.bind(window);
		const state = window as Window & {
			__answerActionRequests?: Array<Record<string, unknown>>;
			__answerActionRelease?: () => void;
		};
		state.__answerActionRequests = [];
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url =
				typeof input === 'string'
					? input
					: input instanceof URL
						? input.href
						: (input as Request).url;
			if (!url.includes('/api/chat/stream')) return originalFetch(input, init);
			state.__answerActionRequests?.push(JSON.parse(String(init?.body || '{}')));
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(`${answerFrame}${citationFrame}data: [DONE]\n\n`)
					);
					state.__answerActionRelease = () => controller.close();
				}
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
			});
		};
	}, { answerFrame, citationFrame });

	return {
		request: () =>
			page.evaluate(() => {
				const state = window as Window & { __answerActionRequests?: Array<Record<string, unknown>> };
				return state.__answerActionRequests?.at(-1) ?? null;
			}),
		release: async () => {
			await page.evaluate(() => {
				const state = window as Window & { __answerActionRelease?: () => void };
				state.__answerActionRelease?.();
			});
			await page.getByRole('button', { name: 'Use answer' }).last().waitFor({ state: 'visible' });
		}
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
				await expect(
					page.getByText('Sign in to continue your newsroom research.')
				).toBeVisible();
				await expect(page.getByRole('link', { name: /create an account/i })).toBeVisible();
				await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
				await page.goto('/signup');
				await expect(page).toHaveURL(/\/signup$/);
				await expect(page.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
				await expect(page.getByLabel('Full name')).toBeVisible();
				await expect(page.getByLabel('Email')).toBeVisible();
				await page.getByLabel('Full name').fill('Friend Reporter');
				await page.getByLabel('Email').fill(`friend-${Date.now()}@example.test`);
				await page.getByLabel('Password', { exact: true }).fill('friend password 123');
				await page.getByLabel('Confirm password').fill('friend password 123');
				await page.getByRole('button', { name: 'Create account' }).click();
				await expect(page).toHaveURL(/\/$/);
				await expectChatStartHome(page);
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
		await expect(page.getByRole('alert')).toHaveText('That password did not match an active account.');
		await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');

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

		const message =
			'Toronto housing: find the newest reliable updates from the past 24 hours, cite source links, and flag anything unconfirmed.';
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
		await expect(page.getByRole('heading', { name: 'What are you working on?' })).toBeVisible();
		await expect(page.getByLabel('Message NewsCraft')).toBeVisible();
		await expect(page.locator('[aria-label="Starter prompts"]')).toBeVisible();
		const mobilePrompts = page.locator('[aria-label="Starter prompts"] button');
		const mobileFirst = await mobilePrompts.nth(0).boundingBox();
		const mobileSecond = await mobilePrompts.nth(1).boundingBox();
		expect(mobileFirst).not.toBeNull();
		expect(mobileSecond).not.toBeNull();
		expect(Math.abs((mobileFirst?.x ?? 0) - (mobileSecond?.x ?? 0))).toBeLessThan(2);
		expect(mobileSecond?.y ?? 0).toBeGreaterThan((mobileFirst?.y ?? 0) + (mobileFirst?.height ?? 0));
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

		await page.getByRole('button', { name: 'Toggle sidebar' }).click();
		const sidebar = page.locator('aside[aria-label="Sidebar"]');
		await expect(sidebar).toBeVisible();
		await expect(page.getByRole('link', { name: 'New chat' })).toBeVisible();

		await sidebar.getByRole('button', { name: 'Close sidebar' }).click();
		await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
		expect(problems).toEqual([]);
	});

	test('uses the tablet width for scannable two-column newsroom tasks', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await page.setViewportSize({ width: 834, height: 1112 });
		await signIn(page);
		await expect(page.getByRole('heading', { name: 'What are you working on?' })).toBeVisible();
		const tabletPrompts = page.locator('[aria-label="Starter prompts"] button');
		const tabletFirst = await tabletPrompts.nth(0).boundingBox();
		const tabletSecond = await tabletPrompts.nth(1).boundingBox();
		expect(tabletFirst).not.toBeNull();
		expect(tabletSecond).not.toBeNull();
		expect(Math.abs((tabletFirst?.y ?? 0) - (tabletSecond?.y ?? 0))).toBeLessThan(2);
		expect(tabletSecond?.x ?? 0).toBeGreaterThan((tabletFirst?.x ?? 0) + (tabletFirst?.width ?? 0));
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(834);
		expect(problems).toEqual([]);
	});
});

test.describe('keyboard navigation and dialog focus', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('traps focus and restores the opener for command dialogs', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await signIn(page);
		const composer = page.getByLabel('Message NewsCraft');
		await composer.focus();

		await page.keyboard.press('Control+K');
		const palette = page.getByRole('dialog', { name: 'Command palette' });
		await expect(palette).toBeVisible();
		const paletteInput = page.getByLabel('Command palette search');
		await expect(paletteInput).toBeFocused();
		await expect(paletteInput).toHaveAttribute('aria-activedescendant', /command-palette-option-0/);

		await page.keyboard.press('Tab');
		await expect(paletteInput).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(palette).toBeHidden();
		await expect(composer).toBeFocused();

		await page.keyboard.down('Control');
		await page.keyboard.press('/');
		await page.keyboard.up('Control');
		const help = page.getByRole('dialog', { name: 'Shortcuts' });
		await expect(help).toBeVisible();
		await expect(help).toBeFocused();

		await page.keyboard.press('Tab');
		await expect(help).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(help).toBeHidden();
		await expect(composer).toBeFocused();

		expect(problems).toEqual([]);
	});

	test('keeps feedback dialog focus contained and closes with Escape', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await signIn(page);
		const convId = await seedConversation(page, {
			userMessage: 'Seed feedback thread',
			assistantMessage: 'Ready for feedback.',
			title: `Feedback a11y ${Date.now().toString(36)}`
		});
		await page.goto(`/c/${convId}`);

		const composer = page.getByLabel('Message NewsCraft');
		await composer.fill('/feedback initial note');
		await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await composer.press('Enter');

		const dialog = page.getByRole('dialog', { name: 'Capture feedback' });
		await expect(dialog).toBeVisible();
		const textarea = page.getByLabel('Feedback comment');
		await expect(textarea).toBeFocused();
		await expect(textarea).toHaveValue('initial note');

		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('button', { name: 'Close feedback' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(textarea).toBeFocused();

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(composer).toBeFocused();
		expect(problems).toEqual([]);
	});

	test('supports Arrow, Enter, and Escape in sidebar search results', async ({ page }) => {
		const problems = await collectPageProblems(page);

		await signIn(page);
		const suffix = Date.now().toString(36);
		const titleA = `A11y ${suffix} alpha thread`;
		const titleB = `A11y ${suffix} beta thread`;
		const alphaId = await seedConversation(page, {
			userMessage: 'Alpha search seed',
			assistantMessage: 'Alpha search result.',
			title: titleA
		});
		const betaId = await seedConversation(page, {
			userMessage: 'Beta search seed',
			assistantMessage: 'Beta search result.',
			title: titleB
		});

		await page.goto('/');
		await page.getByRole('button', { name: 'Search threads' }).click();
		const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
		const search = sidebar.getByRole('combobox', { name: 'Search your threads' });
		await expect(search).toBeFocused();

		const query = `A11y ${suffix}`;
		await search.fill(query);
		const options = sidebar.locator('[role="option"]');
		await expect(options).toHaveCount(2);
		await expect(search).toHaveAttribute('aria-activedescendant', /sidebar-search-result-0/);
		await expect(options.first()).toHaveAttribute('aria-selected', 'true');

		await search.press('Escape');
		await expect(search).toHaveValue('');
		await expect(sidebar.getByRole('listbox', { name: 'Search results' })).toHaveCount(0);
		await expect(search).toBeFocused();

		await search.fill(query);
		await expect(options).toHaveCount(2);
		await search.press('ArrowDown');
		await expect(search).toHaveAttribute('aria-activedescendant', /sidebar-search-result-1/);
		const selected = sidebar.locator('[role="option"][aria-selected="true"]');
		await expect(selected).toHaveCount(1);
		const selectedText = await selected.innerText();
		const expectedId = selectedText.includes(titleA) ? alphaId : betaId;

		await search.press('Enter');
		await expect(page).toHaveURL(new RegExp(`/c/${expectedId}$`));
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

	test('keeps thread drafts isolated and reports clipboard denial visibly', async ({
		page
	}) => {
		const problems = await collectPageProblems(page);
		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: {
					writeText: async () => {
						throw new Error('denied');
					}
				}
			});
		});

		await signIn(page);
		const first = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'first seed',
				assistantMessage: 'first answer'
			},
			headers: { 'content-type': 'application/json' }
		});
		const second = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'second seed',
				assistantMessage: 'second answer'
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!first.ok()) throw new Error(`seed first: ${first.status()} ${await first.text()}`);
		if (!second.ok()) throw new Error(`seed second: ${second.status()} ${await second.text()}`);
		const { id: firstId } = (await first.json()) as { id: string };
		const { id: secondId } = (await second.json()) as { id: string };

		await page.goto(`/c/${firstId}`);
		await page.getByLabel('Message NewsCraft').fill('draft for first thread');
		await page.waitForTimeout(100);
		await page.reload();
		await expect(page.getByLabel('Message NewsCraft')).toHaveValue('draft for first thread');

		await page.goto(`/c/${secondId}`);
		await expect(page.getByLabel('Message NewsCraft')).toHaveValue('');
		await page.getByLabel('Message NewsCraft').fill('draft for second thread');
		await page.waitForTimeout(100);

		await page.goto(`/c/${firstId}`);
		await expect(page.getByLabel('Message NewsCraft')).toHaveValue('draft for first thread');

		await page.getByRole('button', { name: 'Copy message' }).first().click();
		await expect(page.getByRole('button', { name: 'Copy failed' })).toBeVisible();

		expect(problems).toEqual([]);
	});

	test('shows a jump-to-latest recovery control when streaming while scrolled away', async ({
		page
	}) => {
		const problems = await collectPageProblems(page);

		await signIn(page);
		const longAnswer = Array.from(
			{ length: 90 },
			(_, i) => `Seeded context line ${i + 1} for a long thread.`
		).join('\n\n');
		const seedRes = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'long seed',
				assistantMessage: longAnswer
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!seedRes.ok()) throw new Error(`seed-conversation: ${seedRes.status()} ${await seedRes.text()}`);
		const { id: convId } = (await seedRes.json()) as { id: string };
		const releaseStream = await interceptChatStreamWithPlanFixture(page);

		await page.goto(`/c/${convId}`);
		await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
		const scroller = page.locator('.thread');
		await expect
			.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
			.toBeGreaterThan(96);
		await scroller.evaluate((el) => {
			el.scrollTop = 0;
			el.dispatchEvent(new Event('scroll'));
		});

		await page.getByLabel('Message NewsCraft').fill('Any newer update?');
		await page.getByRole('button', { name: 'Send message' }).click();
		const jump = page.getByRole('button', { name: 'Jump to latest message' });
		await expect(jump).toBeVisible();

		await jump.click();
		await expect(jump).toHaveCount(0);
		await releaseStream();

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

test.describe('citation evidence UI', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('opens an accessible evidence preview, restores focus, and becomes a mobile bottom sheet', async ({
		page
	}) => {
		const problems = await collectPageProblems(page);
		await signIn(page);

		const source = {
			id: 'fifa-schedule',
			url: 'https://inside.fifa.com/match-centre',
			title: 'FIFA match schedule',
			domain: 'inside.fifa.com',
			status: 'used',
			firstSeenAt: 1000,
			lastSeenAt: 1100,
			used: true
		};
		const seedRes = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'What FIFA games are being played today?',
				assistantMessage: 'The confirmed match begins at 19:00 local time [1].',
				assistantToolCalls: {
					version: 1,
					tools: [],
					sources: [source],
					citations: [
						{
							citationNumber: 1,
							title: 'FIFA match schedule',
							url: source.url,
							domain: source.domain,
							publicationDate: '2026-07-10',
							sourceType: 'official',
							supportingExcerpt: 'The match begins at 19:00 local time.'
						}
					]
				}
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!seedRes.ok()) throw new Error(`seed-conversation: ${seedRes.status()} ${await seedRes.text()}`);
		const { id: convId } = (await seedRes.json()) as { id: string };

		await page.goto(`/c/${convId}`);
		const citation = page.getByRole('button', { name: 'Citation 1: FIFA match schedule' });
		await expect(citation).toBeVisible();
		await expect(page.locator('[data-testid="message-sources"]')).toHaveCount(0);

		await citation.focus();
		await citation.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'FIFA match schedule' });
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Official source');
		await expect(dialog).toContainText('The match begins at 19:00 local time.');
		await expect(dialog.getByRole('link', { name: 'Open original' })).toHaveAttribute(
			'href',
			source.url
		);
		await expect(page.getByRole('button', { name: 'Close evidence preview' })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('link', { name: 'Open original' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.getByRole('button', { name: 'Close evidence preview' })).toBeFocused();

		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(citation).toBeFocused();

		await page.setViewportSize({ width: 390, height: 844 });
		await citation.click();
		const sheet = page.locator('[data-testid="evidence-preview"]');
		await expect(sheet).toBeVisible();
		const box = await sheet.boundingBox();
		expect(box).not.toBeNull();
		expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - 844)).toBeLessThan(2);
		expect(box?.width).toBe(390);
		await page.keyboard.press('Escape');

		await page.reload();
		const reloadedCitation = page.getByRole('button', { name: 'Citation 1: FIFA match schedule' });
		await expect(reloadedCitation).toBeVisible();
		await reloadedCitation.click();
		await expect(page.getByRole('dialog', { name: 'FIFA match schedule' })).toContainText('Jul 10, 2026');
		await page.locator('.evidence-backdrop__dismiss').click({ position: { x: 5, y: 5 } });
		await expect(page.getByRole('dialog', { name: 'FIFA match schedule' })).toHaveCount(0);
		await expect(reloadedCitation).toBeFocused();

		expect(problems).toEqual([]);
	});

	test('keeps the legacy source disclosure when a visible citation is unresolved', async ({ page }) => {
		await signIn(page);
		const seedRes = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'Check this schedule.',
				assistantMessage: 'The schedule remains unconfirmed [2].',
				assistantToolCalls: {
					version: 1,
					tools: [],
					sources: [
						{
							id: 'schedule-source',
							url: 'https://example.com/schedule',
							title: 'Schedule source',
							status: 'used',
							firstSeenAt: 1000,
							lastSeenAt: 1100,
							used: true
						}
					],
					citations: [
						{
							citationNumber: 2,
							title: 'Different source',
							url: 'https://example.com/different',
							domain: 'example.com',
							publicationDate: null,
							sourceType: 'unknown',
							supportingExcerpt: ''
						}
					]
				}
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!seedRes.ok()) throw new Error(`seed-conversation: ${seedRes.status()} ${await seedRes.text()}`);
		const { id: convId } = (await seedRes.json()) as { id: string };

		await page.goto(`/c/${convId}`);
		await expect(page.getByText('The schedule remains unconfirmed')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Citation 2: Different source' })).toHaveCount(0);
		await expect(page.locator('[data-testid="message-sources"]')).toBeVisible();
	});
});

test.describe('answer handoff actions', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('runs all four formats as visible follow-up turns with inherited citations and no research steps', async ({
		page
	}) => {
		await signIn(page);
		const seedRes = await page.request.post('/api/e2e/seed-conversation', {
			data: {
				secret: e2eSecret,
				password,
				userMessage: 'What FIFA games are being played today?',
				assistantMessage: 'The confirmed match begins at 19:00 local time [1].',
				assistantToolCalls: {
					version: 1,
					tools: [],
					sources: [],
					citations: [
						{
							citationNumber: 1,
							title: 'FIFA match schedule',
							url: 'https://inside.fifa.com/match-centre',
							domain: 'inside.fifa.com',
							publicationDate: '2026-07-10',
							sourceType: 'official',
							supportingExcerpt: 'The confirmed match begins at 19:00 local time.'
						}
					]
				}
			},
			headers: { 'content-type': 'application/json' }
		});
		if (!seedRes.ok()) throw new Error(`seed-conversation: ${seedRes.status()} ${await seedRes.text()}`);
		const { id: convId } = (await seedRes.json()) as { id: string };
		const fixture = await installAnswerActionStreamFixture(page);
		await page.goto(`/c/${convId}`);
		await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
		const sourceArticle = page.locator('article.msg--assistant').last();
		const sourceDomId = await sourceArticle.getAttribute('id');
		const sourceMessageId = sourceDomId?.replace(/^m-/, '');
		expect(sourceMessageId).toBeTruthy();
		const actions = [
			['Producer brief', 'producer_brief', 'Create a producer brief from this answer.'],
			['30-second script', 'thirty_second_script', 'Turn this answer into a 30-second script.'],
			['Interview questions', 'interview_questions', 'Draft interview questions from this answer.'],
			['Copy with citations', 'copy_with_citations', 'Turn this answer into clean copy with citations.']
		] as const;

		for (const [index, [label, action, visibleRequest]] of actions.entries()) {
			if (index === 0) {
				await page
					.getByTestId('answer-utility-bar')
					.getByRole('button', { name: 'Use answer' })
					.click();
				await page.getByRole('menuitem', { name: label }).click();
			} else {
				await page
					.getByTestId('newsroom-artifact-pane')
					.getByRole('button', { name: label })
					.click();
			}
			await expect(page.getByTestId('newsroom-artifact-pane')).toBeVisible();
			await expect(page.getByText(visibleRequest)).toBeVisible();
			await expect.poll(fixture.request).toMatchObject({
				conversation_id: convId,
				output_action: action,
				source_message_id: sourceMessageId
			});
			await expect(page.locator('[data-testid="plan-timeline"]')).toHaveCount(0);
			const persistRes = await page.request.post('/api/e2e/seed-conversation', {
				data: {
					secret: e2eSecret,
					password,
					conversationId: convId,
					userMessage: visibleRequest,
					assistantMessage: 'Formatted answer with inherited evidence [1].',
					assistantToolCalls: {
						version: 1,
						tools: [],
						sources: [],
						citations: [
							{
								citationNumber: 1,
								title: 'FIFA match schedule',
								url: 'https://inside.fifa.com/match-centre',
								domain: 'inside.fifa.com',
								publicationDate: '2026-07-10',
								sourceType: 'official',
								supportingExcerpt: 'The confirmed match begins at 19:00 local time.'
							}
						]
					}
				},
				headers: { 'content-type': 'application/json' }
			});
			if (!persistRes.ok()) {
				throw new Error(`persist-answer-action: ${persistRes.status()} ${await persistRes.text()}`);
			}
			await fixture.release();
			await expect(page.getByText('Formatted answer with inherited evidence').last()).toBeVisible();
			await expect(
				page.getByRole('button', { name: 'Citation 1: FIFA match schedule' }).last()
			).toBeVisible();
			await expect(page.getByTestId('newsroom-artifact-pane')).toContainText('1 citation');
		}
	});
});

test.describe('private PDF composer lifecycle', () => {
	test.beforeAll(async ({ request }) => {
		await ensureTestAccount(request);
	});

	test('shows upload states, blocks early sends, removes files, and restores a ready PDF after send failure', async ({
		page
	}) => {
		await signIn(page);
		const convId = await seedConversation(page, {
			userMessage: 'Review the attached source document.',
			assistantMessage: 'Attach the PDF when ready.'
		});

		let releaseToken: (() => void) | undefined;
		let releaseUpload: (() => void) | undefined;
		let releaseProcess: (() => void) | undefined;
		let tokenCount = 0;
		let failUpload = false;
		const firstTokenGate = new Promise<void>((resolve) => (releaseToken = resolve));
		const firstUploadGate = new Promise<void>((resolve) => (releaseUpload = resolve));
		const firstProcessGate = new Promise<void>((resolve) => (releaseProcess = resolve));

		await page.route('**/api/health*', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ app: { capabilities: { documents: true } } })
			})
		);
		await page.route('**/documents/upload-token', async (route) => {
			tokenCount += 1;
			if (tokenCount === 1) await firstTokenGate;
			const id = `doc-${tokenCount}`;
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					documents: [
						{
							document: {
								id,
								filename: tokenCount === 2 ? 'failed.pdf' : 'notes.pdf',
								state: 'uploading',
								pageCount: null,
								error: null
							},
							upload: {
								path: `org/conversation/${id}/file.pdf`,
								token: `token-${id}`,
								signedUrl: `https://storage.example/upload/${id}?token=token-${id}`
							}
						}
					]
				})
			});
		});
		await page.route('https://storage.example/**', async (route) => {
			if (tokenCount === 1) await firstUploadGate;
			await route.fulfill({ status: failUpload ? 500 : 200, body: '{}' });
		});
		await page.route('**/documents/*/process', async (route) => {
			if (tokenCount === 1) await firstProcessGate;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					document: {
						id: `doc-${tokenCount}`,
						filename: 'notes.pdf',
						state: 'ready',
						pageCount: 2,
						error: null
					}
				})
			});
		});
		await page.route(/\/api\/conversations\/[^/]+\/documents\/doc-\d+$/, (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
		);
		await page.goto(`/c/${convId}`);
		await expect(page.getByRole('button', { name: 'Attach image or PDF' })).toBeVisible();

		const input = page.locator('input[type="file"]');
		await input.setInputFiles({
			name: 'notes.pdf',
			mimeType: 'application/pdf',
			buffer: Buffer.from('%PDF-1.4\nfixture')
		});
		await expect(page.getByText('Uploading', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
		releaseToken?.();
		await expect(page.getByText('Uploading', { exact: true })).toBeVisible();
		releaseUpload?.();
		await expect(page.getByText('Processing', { exact: true })).toBeVisible();
		releaseProcess?.();
		await expect(page.getByText('2 pages ready', { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
		await page.getByRole('button', { name: 'Remove notes.pdf' }).click();
		await expect(page.getByText('2 pages ready', { exact: true })).toHaveCount(0);

		failUpload = true;
		await input.setInputFiles({
			name: 'failed.pdf',
			mimeType: 'application/pdf',
			buffer: Buffer.from('%PDF-1.4\nfailed fixture')
		});
		await expect(page.getByText("Couldn't upload that PDF. Try again.", { exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
		await page.getByRole('button', { name: 'Remove failed.pdf' }).click();

		failUpload = false;
		await input.setInputFiles({
			name: 'notes.pdf',
			mimeType: 'application/pdf',
			buffer: Buffer.from('%PDF-1.4\nretry fixture')
		});
		await expect(page.getByText('2 pages ready', { exact: true })).toBeVisible();
		await page.route('**/api/chat/stream', (route) =>
			route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' })
		);
		const composer = page.getByLabel('Message NewsCraft');
		await composer.fill('Summarize this private PDF.');
		await page.getByRole('button', { name: 'Send message' }).click();
		await expect(composer).toHaveValue('Summarize this private PDF.');
		await expect(page.getByText('2 pages ready', { exact: true })).toBeVisible();
		await expect(page.getByText("Couldn't send. Your draft is still here.", { exact: true })).toBeVisible();
	});
});
