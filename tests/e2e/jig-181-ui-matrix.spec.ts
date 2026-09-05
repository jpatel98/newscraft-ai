import { expect, test, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import {
	JIG181_LAYOUT_SHIFT_THRESHOLD,
	JIG181_VIEWPORTS,
	caseById,
	duplicateDurableStartCount
} from '../../scripts/jig-181-ui-matrix-contract.mjs';

const password = 'correct horse battery staple';
const e2eSecret = process.env.E2E_SECRET ?? 'newscraft-e2e-seed-secret';
const fixtureAnswer = 'Local fixture answer [1].';
const newFixtureAnswer = 'New local fixture answer [2].';
const fixtureCitation = {
	citationNumber: 1,
	title: 'Local fixture source',
	url: 'https://example.test/local-fixture',
	domain: 'example.test',
	publicationDate: '2026-08-27',
	sourceType: 'official',
	supportingExcerpt: 'A bounded local fixture source.'
};

type MatrixMetrics = {
	consoleErrorCount: number;
	pageErrorCount: number;
	failedRequestCount: number;
	duplicateRequestCount: number;
	layoutShift: number;
	layoutShiftSupported: boolean;
};

type FixtureMode = 'complete' | 'reconnect' | 'error-retry' | 'cancel';

function sse(event: string, data: unknown, id?: number): string {
	return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function snapshot(
	runId: string,
	conversationId: string,
	state: string,
	cursor: number,
	answerText = '',
	errorMessage: string | null = null
) {
	return {
		run_id: runId,
		conversation_id: conversationId,
		assistant_message_id: 'fixture-assistant',
		cursor,
		status: state,
		state,
		answerText,
		sources: [],
		citations: [],
		tools: [],
		errorMessage
	};
}

function failedBody(runId: string, conversationId: string): string {
	return (
		sse('agent.meta', { conversation_id: conversationId, run_id: runId }) +
		sse('agent.persistence_error', { message: 'local fixture failure' }, 2) +
		'data: [DONE]\n\n'
	);
}

function completeBody(runId: string, conversationId: string): string {
	return (
		sse('agent.meta', { conversation_id: conversationId, run_id: runId }) +
		sse('run.snapshot', snapshot(runId, conversationId, 'researching', 1)) +
		sse('agent.citations', { citations: [fixtureCitation] }, 2) +
		sse('response.output_text.delta', { delta: newFixtureAnswer }, 3) +
		sse('run.snapshot', snapshot(runId, conversationId, 'complete', 4, newFixtureAnswer)) +
		'data: [DONE]\n\n'
	);
}

function reconnectBody(runId: string, conversationId: string): string {
	return (
		sse('agent.meta', { conversation_id: conversationId, run_id: runId }) +
		sse('run.snapshot', snapshot(runId, conversationId, 'researching', 1))
	);
}

function cancelledBody(runId: string, conversationId: string): string {
	return (
		sse('agent.meta', { conversation_id: conversationId, run_id: runId }) +
		sse('run.snapshot', snapshot(runId, conversationId, 'cancelled', 2)) +
		'data: [DONE]\n\n'
	);
}

async function ensureTestAccount(request: APIRequestContext) {
	const response = await request.post('/api/e2e/seed', {
		data: { secret: e2eSecret, password },
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`JIG-181 test account provisioning failed: ${response.status()}`);
}

async function signIn(page: Page) {
	await page.goto('/login');
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true');
	await expect(page.getByLabel('Message NewsCraft')).toHaveAttribute('data-ready', 'true');
}

async function seedConversation(page: Page, userMessage = 'Local matrix thread') {
	const response = await page.request.post('/api/e2e/seed-conversation', {
		data: {
			secret: e2eSecret,
			password,
			userMessage,
			assistantMessage: fixtureAnswer,
			assistantToolCalls: {
				version: 1,
				tools: [],
				sources: [
					{
						id: 'local-fixture-source',
						url: fixtureCitation.url,
						title: fixtureCitation.title,
						domain: fixtureCitation.domain,
						status: 'used',
						firstSeenAt: 1_000,
						lastSeenAt: 1_100,
						used: true
					}
				],
				citations: [fixtureCitation]
			}
		},
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`JIG-181 conversation fixture failed: ${response.status()}`);
	return ((await response.json()) as { id: string }).id;
}

async function openThread(page: Page, userMessage?: string) {
	await signIn(page);
	const conversationId = await seedConversation(page, userMessage);
	await page.goto(`/c/${conversationId}`);
	await expect(page.locator('.pane__header__title')).toBeVisible();
	return conversationId;
}

async function persistFixtureTurn(context: BrowserContext, conversationId: string, userMessage: string) {
	const response = await context.request.post('/api/e2e/seed-conversation', {
		data: {
			secret: e2eSecret,
			password,
			conversationId,
			userMessage,
			assistantMessage: newFixtureAnswer,
			assistantToolCalls: {
				version: 1,
				tools: [],
				sources: [
					{
						id: 'local-fixture-source',
						url: fixtureCitation.url,
						title: fixtureCitation.title,
						domain: fixtureCitation.domain,
						status: 'used',
						firstSeenAt: 1_000,
						lastSeenAt: 1_100,
						used: true
					}
				],
				citations: [fixtureCitation]
			}
		},
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) {
		throw new Error(`JIG-181 durable fixture persistence failed: ${response.status()} ${await response.text()}`);
	}
}

async function installMetrics(page: Page) {
	await page.addInitScript(() => {
		const state = {
			layoutShift: 0,
			layoutShiftSupported:
				typeof PerformanceObserver !== 'undefined' &&
				Array.isArray(PerformanceObserver.supportedEntryTypes) &&
				PerformanceObserver.supportedEntryTypes.includes('layout-shift')
		};
		(window as Window & { __jig181Metrics?: typeof state }).__jig181Metrics = state;
		if (!state.layoutShiftSupported) return;
		try {
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
					if (!shift.hadRecentInput && typeof shift.value === 'number') state.layoutShift += shift.value;
				}
			});
			observer.observe({ type: 'layout-shift', buffered: true });
		} catch {
			state.layoutShiftSupported = false;
		}
	});
}

async function readMetrics(page: Page, duplicateRequestCount: number): Promise<MatrixMetrics> {
	const browserMetrics = await page.evaluate(() => {
		const state = (window as Window & {
			__jig181Metrics?: { layoutShift: number; layoutShiftSupported: boolean };
		}).__jig181Metrics;
		return {
			layoutShift: state?.layoutShift ?? Number.NaN,
			layoutShiftSupported: state?.layoutShiftSupported === true
		};
	});
	return {
		consoleErrorCount: 0,
		pageErrorCount: 0,
		failedRequestCount: 0,
		duplicateRequestCount,
		layoutShift: browserMetrics.layoutShift,
		layoutShiftSupported: browserMetrics.layoutShiftSupported
	};
}

async function installPageProblemCounters(page: Page) {
	let consoleErrorCount = 0;
	let pageErrorCount = 0;
	let failedRequestCount = 0;
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrorCount += 1;
	});
	page.on('pageerror', () => {
		pageErrorCount += 1;
	});
	page.on('requestfailed', () => {
		failedRequestCount += 1;
	});
	return (duplicateRequestCount: number) =>
		readMetrics(page, duplicateRequestCount).then((metrics) => ({
			...metrics,
			consoleErrorCount,
			pageErrorCount,
			failedRequestCount
		}));
}

async function finishEvidence(
	page: Page,
	testInfo: TestInfo,
	caseId: string,
	metricsReader: (duplicateRequestCount: number) => Promise<MatrixMetrics>,
	duplicateRequestCount: number
) {
	const caseSpec = caseById(caseId);
	if (!caseSpec) throw new Error(`unknown JIG-181 case ${caseId}`);
	await page.waitForTimeout(100);
	const metrics = await metricsReader(duplicateRequestCount);
	expect(metrics.layoutShiftSupported).toBe(true);
	expect(metrics.consoleErrorCount).toBe(0);
	expect(metrics.pageErrorCount).toBe(0);
	expect(metrics.failedRequestCount).toBe(0);
	expect(metrics.layoutShift).toBeLessThanOrEqual(JIG181_LAYOUT_SHIFT_THRESHOLD);
	expect(metrics.duplicateRequestCount).toBe(0);
	const screenshotPath = testInfo.outputPath(`${caseId}.png`);
	await page.screenshot({ path: screenshotPath, fullPage: false });
	testInfo.attachments.push({ name: 'jig181-screenshot', path: screenshotPath, contentType: 'image/png' });
	const browserVersion = page.context().browser()?.version() ?? 'unknown';
	testInfo.annotations.push({
		type: 'jig181-evidence',
		description: JSON.stringify({
			case_id: caseId,
			browser_project: testInfo.project.name,
			browser_name: 'chromium',
			browser_version: browserVersion,
			viewport: caseSpec.viewport,
			console_error_count: metrics.consoleErrorCount,
			page_error_count: metrics.pageErrorCount,
			failed_request_count: metrics.failedRequestCount,
			layout_shift: metrics.layoutShift,
			duplicate_request_count: metrics.duplicateRequestCount,
			state: 'PASS'
		})
	});
}

function requireProject(testInfo: TestInfo, viewportId: string) {
	test.skip(testInfo.project.name !== `jig181-${viewportId}`, `case runs in ${viewportId}`);
}

async function installDurableFixture(context: BrowserContext, mode: FixtureMode) {
	const counts = { post: 0, reconnectGet: 0, cancel: 0 };
	let activeMode = mode;
	let lastConversationId = 'fixture-conversation';
	let lastUserMessage = 'Local durable fixture turn';
	let persisted = false;
	await context.route('**/api/chat/runs**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === '/api/chat/runs' && request.method() === 'POST') {
			counts.post += 1;
			let conversationId = 'fixture-conversation';
			try {
				const body = JSON.parse(request.postData() ?? '{}') as {
					conversation_id?: string;
					content?: string;
				};
				conversationId = body.conversation_id || conversationId;
				lastUserMessage = body.content || lastUserMessage;
			} catch {
				/* The application will surface a normal request failure. */
			}
			lastConversationId = conversationId;
			const requestMode = activeMode;
			if (requestMode === 'error-retry' && counts.post === 1) {
				// A terminal durable failure must expose the UI retry action without
				// creating a browser-level failed-resource console entry.
				await route.fulfill({
					status: 200,
					headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
					body: failedBody('fixture-run-1', conversationId)
				});
				return;
			}
			const runId = 'fixture-run-1';
			if (requestMode === 'reconnect') await new Promise((resolve) => setTimeout(resolve, 100));
			if (requestMode === 'error-retry' && counts.post === 2 && !persisted) {
				await persistFixtureTurn(context, conversationId, lastUserMessage);
				persisted = true;
			}
			const body = requestMode === 'reconnect' || requestMode === 'cancel' || requestMode === 'complete'
				? reconnectBody(runId, conversationId)
				: completeBody(runId, conversationId);
			await route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
				body
			});
			return;
		}
		if (url.pathname.endsWith('/cancel') && request.method() === 'POST') {
			counts.cancel += 1;
			const runId = url.pathname.split('/').at(-2) || 'fixture-run-1';
			await route.fulfill({
				status: 202,
				contentType: 'application/json',
				body: JSON.stringify({ run_id: runId, cursor: 2, status: 'cancelled', state: 'cancelled' })
			});
			return;
		}
		if (url.pathname.startsWith('/api/chat/runs/') && request.method() === 'GET') {
			counts.reconnectGet += 1;
			const runId = url.pathname.split('/').at(-1) || 'fixture-run-1';
			const conversationId = lastConversationId;
			const requestMode = activeMode;
			if (requestMode !== 'cancel' && !persisted) {
				await persistFixtureTurn(context, conversationId, lastUserMessage);
				persisted = true;
			}
			const body = requestMode === 'cancel'
				? cancelledBody(runId, conversationId)
				: completeBody(runId, conversationId);
			await route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
				body
			});
			return;
		}
		await route.fallback();
	});
	return {
		get post() {
			return counts.post;
		},
		get reconnectGet() {
			return counts.reconnectGet;
		},
		get cancel() {
			return counts.cancel;
		},
		observed() {
			return { ...counts };
		},
		setMode(next: FixtureMode) {
			activeMode = next;
		}
	};
}

async function seedLongConversation(page: Page) {
	await signIn(page);
	const longAnswer = `${fixtureAnswer} ${'Local bounded thread content. '.repeat(180)}`;
	const response = await page.request.post('/api/e2e/seed-conversation', {
		data: {
			secret: e2eSecret,
			password,
			userMessage: 'Long local matrix thread',
			assistantMessage: longAnswer
		},
		headers: { 'content-type': 'application/json' }
	});
	if (!response.ok()) throw new Error(`JIG-181 long conversation fixture failed: ${response.status()}`);
	const id = ((await response.json()) as { id: string }).id;
	await page.goto(`/c/${id}`);
}

test.beforeAll(async ({ request }) => {
	await ensureTestAccount(request);
});

test.beforeEach(async ({ context }) => {
	// Keep browser evidence local and deterministic. These app-owned requests
	// otherwise probe the intentionally unreachable Hermes endpoint during a
	// fixture conversation and produce browser-level 5xx console entries.
	await context.route('**/api/health**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ app: { capabilities: { documents: false } } })
		});
	});
	await context.route('**/api/conversations/*/title', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ title: 'Local fixture title' })
		});
	});
});

for (const viewport of JIG181_VIEWPORTS) {
	test(`JIG-181 viewport ${viewport.id}`, async ({ page }, testInfo) => {
		requireProject(testInfo, viewport.id);
		await installMetrics(page);
		const readProblems = await installPageProblemCounters(page);
		await signIn(page);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
		const caseId = viewport.kind === 'mobile'
			? `viewport_${viewport.width}x${viewport.height}`
			: `viewport_${viewport.kind}_${viewport.width}x${viewport.height}`;
		await finishEvidence(page, testInfo, caseId, readProblems, 0);
	});
}

test('JIG-181 keyboard opens and closes with the visual viewport', async ({ page }, testInfo) => {
	requireProject(testInfo, 'mobile-390x844');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await signIn(page);
	const composer = page.getByLabel('Message NewsCraft');
	await composer.focus();
	await page.evaluate(() => {
		if (!window.visualViewport) return;
		Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 390 });
		Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 128 });
		window.visualViewport.dispatchEvent(new Event('resize'));
	});
	await expect(page.locator('.shell')).toHaveAttribute('data-keyboard-open', 'true');
	await composer.blur();
	await page.evaluate(() => {
		if (!window.visualViewport) return;
		Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 844 });
		Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 0 });
		window.dispatchEvent(new Event('orientationchange'));
	});
	await expect(page.locator('.shell')).toHaveAttribute('data-keyboard-open', 'false');
	await finishEvidence(page, testInfo, 'keyboard_open_close', readProblems, 0);
});

test('JIG-181 rotation preserves the bounded mobile layout', async ({ page }, testInfo) => {
	requireProject(testInfo, 'mobile-390x844');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await signIn(page);
	await page.setViewportSize({ width: 844, height: 390 });
	await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
	await finishEvidence(page, testInfo, 'orientation_rotation', readProblems, 0);
});

test('JIG-181 browser chrome offsets keep the shell inside the visual viewport', async ({ page }, testInfo) => {
	requireProject(testInfo, 'mobile-390x844');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await signIn(page);
	await page.evaluate(() => {
		if (!window.visualViewport) return;
		Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 700 });
		Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 72 });
		window.visualViewport.dispatchEvent(new Event('resize'));
	});
	await expect(page.locator('.shell')).toHaveCSS('top', '72px');
	await expect(page.locator('.shell')).toHaveCSS('height', '700px');
	await finishEvidence(page, testInfo, 'visual_viewport_offsets', readProblems, 0);
});

test('JIG-181 long threads remain scrollable during fast scroll', async ({ page }, testInfo) => {
	requireProject(testInfo, 'mobile-390x844');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await seedLongConversation(page);
	const scroller = page.locator('.thread');
	await expect(scroller).toBeVisible();
	const dimensions = await scroller.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
		element.scrollTop = 0;
		return { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
	});
	expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await finishEvidence(page, testInfo, 'long_thread_fast_scroll', readProblems, 0);
});

test('JIG-181 drawer and command modal restore focus', async ({ page }, testInfo) => {
	requireProject(testInfo, 'mobile-320x700');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await signIn(page);
	const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
	await toggle.click();
	const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
	await expect(sidebar).toBeVisible();
	await sidebar.getByRole('button', { name: 'Close sidebar' }).click();
	await expect(toggle).toBeFocused();
	await page.keyboard.press('Control+K');
	const palette = page.getByRole('dialog', { name: 'Command palette' });
	await expect(palette).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(palette).toBeHidden();
	await expect(toggle).toBeFocused();
	await finishEvidence(page, testInfo, 'drawer_modal_focus_restoration', readProblems, 0);
});

test('JIG-181 reduced motion and effective 200 percent zoom remain usable', async ({ page }, testInfo) => {
	requireProject(testInfo, 'desktop-1440x900');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await signIn(page);
	await page.evaluate(() => {
		document.documentElement.style.zoom = '2';
	});
	await expect(page.getByRole('heading', { name: 'What are you working on?' })).toBeVisible();
	await finishEvidence(page, testInfo, 'zoom_200_reduced_motion', readProblems, 0);
});

test('JIG-181 reconnect reuses the durable run and does not resubmit', async ({ page, context }, testInfo) => {
	requireProject(testInfo, 'mobile-390x844');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	const counts = await installDurableFixture(context, 'reconnect');
	await openThread(page, 'Reconnect local matrix thread');
	await page.getByLabel('Message NewsCraft').fill('Reconnect once');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.getByText(newFixtureAnswer).first()).toBeVisible();
	await expect.poll(() => counts.reconnectGet).toBeGreaterThan(0);
	expect(counts.post).toBe(1);
	await finishEvidence(page, testInfo, 'network_disconnect_reconnect', readProblems, duplicateDurableStartCount(counts.post, 1));
});

test('JIG-181 server error exposes retry and cancellation uses the existing route', async ({ page, context }, testInfo) => {
	requireProject(testInfo, 'mobile-390x844');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	const counts = await installDurableFixture(context, 'error-retry');
	await openThread(page, 'Server failure local matrix thread');
	await page.getByLabel('Message NewsCraft').fill('Retry local matrix');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.getByRole('button', { name: 'Retry' }).last()).toBeVisible();
	await page.getByRole('button', { name: 'Retry' }).last().click();
	await expect(page.getByText(newFixtureAnswer).first()).toBeVisible();
	expect(counts.post).toBe(2);
	counts.setMode('cancel');
	await page.getByLabel('Message NewsCraft').fill('Cancel local matrix');
	await page.getByRole('button', { name: 'Send message' }).click();
	await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
	await expect.poll(() => counts.cancel).toBeGreaterThan(0);
	await expect.poll(() => counts.reconnectGet).toBeGreaterThan(0);
	expect(counts.cancel).toBe(1);
	expect(counts.post).toBe(3);
	await finishEvidence(page, testInfo, 'server_error_retry_cancel', readProblems, duplicateDurableStartCount(counts.post, 3));
});

test('JIG-181 stale tabs replay one saved run without a duplicate start', async ({ page, context }, testInfo) => {
	requireProject(testInfo, 'tablet-768x1024');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	const counts = await installDurableFixture(context, 'complete');
	const conversationId = await openThread(page, 'Stale tab local matrix thread');
	await page.getByLabel('Message NewsCraft').fill('One durable submit');
	await page.getByRole('button', { name: 'Send message' }).click();
	await expect(page.getByText(newFixtureAnswer).first()).toBeVisible();
	const secondTab = await context.newPage();
	await secondTab.goto(`/c/${conversationId}`);
	await expect(secondTab.getByText(newFixtureAnswer).first()).toBeVisible();
	await secondTab.reload();
	await expect(secondTab.getByText(newFixtureAnswer).first()).toBeVisible();
	expect(counts.post).toBe(1);
	expect(counts.reconnectGet).toBeGreaterThan(0);
	await secondTab.close();
	await finishEvidence(page, testInfo, 'stale_tab_duplicate_requests', readProblems, duplicateDurableStartCount(counts.post, 1));
});

test('JIG-181 persisted sources survive reload and layout remains stable', async ({ page }, testInfo) => {
	requireProject(testInfo, 'desktop-1440x900');
	await installMetrics(page);
	const readProblems = await installPageProblemCounters(page);
	await openThread(page, 'Persisted source local matrix thread');
	await expect(page.getByRole('button', { name: 'Citation 1: Local fixture source' })).toBeVisible();
	await expect(page.locator('[data-testid="message-sources"]')).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Citation 1: Local fixture source' })).toBeVisible();
	await expect(page.locator('[data-testid="message-sources"]')).toHaveCount(0);
	await finishEvidence(page, testInfo, 'console_and_layout_stability', readProblems, 0);
});
