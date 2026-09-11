import { describe, expect, it } from 'vitest';
import {
	createMarkdownStreamScheduler,
	type MarkdownStreamRender,
	type MarkdownStreamSchedulerOptions
} from './markdown-stream-scheduler';
import { prepareAssistantMarkdown, renderMarkdownToHtml } from './markdown-render';

function fakeFrameClock() {
	let nextHandle = 1;
	const callbacks = new Map<number, () => void>();
	const cancelled: number[] = [];
	return {
		requestAnimationFrame(callback: () => void) {
			const handle = nextHandle++;
			callbacks.set(handle, callback);
			return handle;
		},
		cancelAnimationFrame(handle: number) {
			cancelled.push(handle);
			callbacks.delete(handle);
		},
		flushNext() {
			const next = callbacks.entries().next().value as [number, () => void] | undefined;
			if (!next) return;
			callbacks.delete(next[0]);
			next[1]();
		},
		pendingCount: () => callbacks.size,
		cancelled
	};
}

function fakeTimerClock() {
	let nextHandle = 1;
	let now = 0;
	const callbacks = new Map<number, { callback: () => void; dueAt: number }>();
	const cleared: number[] = [];
	return {
		setTimeout(callback: () => void, delayMs: number) {
			const handle = nextHandle++;
			callbacks.set(handle, { callback, dueAt: now + delayMs });
			return handle;
		},
		clearTimeout(handle: number) {
			cleared.push(handle);
			callbacks.delete(handle);
		},
		advance(ms: number) {
			now += ms;
			for (const [handle, entry] of [...callbacks.entries()]) {
				if (entry.dueAt > now) continue;
				callbacks.delete(handle);
				entry.callback();
			}
		},
		pendingCount: () => callbacks.size,
		cleared
	};
}

describe('markdown stream scheduler', () => {
	it('coalesces rapid partial updates into one latest-frame render', () => {
		const clock = fakeFrameClock();
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), clock);

		scheduler.update('a', true);
		scheduler.update('ab', true);
		scheduler.update('abc', true);

		expect(clock.pendingCount()).toBe(1);
		expect(renders).toEqual([]);
		clock.flushNext();
		expect(renders).toEqual([{ content: 'abc', partial: true }]);
	});

	it('replaces queued-frame content without scheduling another frame', () => {
		const clock = fakeFrameClock();
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), clock);

		scheduler.update('first', true);
		scheduler.update('replacement', true);
		expect(clock.pendingCount()).toBe(1);
		clock.flushNext();
		expect(renders.at(-1)).toEqual({ content: 'replacement', partial: true });
	});

	it('bounds long partial parse bursts to the cadence and keeps the latest content', () => {
		const frameClock = fakeFrameClock();
		const timerClock = fakeTimerClock();
		const renders: MarkdownStreamRender[] = [];
		let parseCount = 0;
		let naiveParseCount = 0;
		const scheduler = createMarkdownStreamScheduler(
			(render) => {
				parseCount += 1;
				renders.push({ content: renderMarkdownToHtml(render.content), partial: render.partial });
			},
			{
				requestAnimationFrame: frameClock.requestAnimationFrame,
				cancelAnimationFrame: frameClock.cancelAnimationFrame,
				setTimeout: timerClock.setTimeout,
				clearTimeout: timerClock.clearTimeout as MarkdownStreamSchedulerOptions['clearTimeout'],
				partialContentThreshold: 10,
				partialCadenceMs: 50
			}
		);

		for (let index = 0; index < 200; index += 1) {
			naiveParseCount += 1;
			scheduler.update('**chunk ' + index + '** ' + 'x'.repeat(20), true);
		}

		expect(parseCount).toBe(0);
		expect(frameClock.pendingCount()).toBe(0);
		expect(timerClock.pendingCount()).toBe(1);
		timerClock.advance(49);
		expect(parseCount).toBe(0);
		timerClock.advance(1);
		expect(parseCount).toBe(1);
		expect(parseCount).toBeLessThan(naiveParseCount);
		expect(renders.at(-1)?.content).toContain('chunk 199');
		expect(timerClock.pendingCount()).toBe(0);
	});

	it('replaces and cancels a queued long-answer cadence for an authoritative terminal update', () => {
		const clock = fakeTimerClock();
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), {
			requestAnimationFrame: undefined,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout as MarkdownStreamSchedulerOptions['clearTimeout'],
			partialContentThreshold: 1,
			partialCadenceMs: 50
		});

		scheduler.update('queued partial', true);
		scheduler.update('authoritative final', false);
		clock.advance(100);

		expect(renders).toEqual([{ content: 'authoritative final', partial: false }]);
		expect(clock.cleared).toEqual([1]);
	});

	it('flushes terminal and failure replacements synchronously', () => {
		const clock = fakeFrameClock();
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), clock);

		scheduler.update('partial', true);
		scheduler.update('final answer', false);
		scheduler.update('failure message', false);

		expect(renders).toEqual([
			{ content: 'final answer', partial: false },
			{ content: 'failure message', partial: false }
		]);
		expect(clock.pendingCount()).toBe(0);
	});

	it('cancels a pending frame when the component is destroyed', () => {
		const clock = fakeFrameClock();
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), clock);

		scheduler.update('pending', true);
		scheduler.destroy();
		clock.flushNext();

		expect(renders).toEqual([]);
		expect(clock.cancelled).toEqual([1]);
	});

	it('cancels a pending long-answer cadence when the component is destroyed', () => {
		const clock = fakeTimerClock();
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), {
			requestAnimationFrame: undefined,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout as MarkdownStreamSchedulerOptions['clearTimeout'],
			partialContentThreshold: 1,
			partialCadenceMs: 50
		});

		scheduler.update('pending', true);
		scheduler.destroy();
		clock.advance(100);

		expect(renders).toEqual([]);
		expect(clock.cleared).toEqual([1]);
	});

	it('renders SSR initial content immediately and preserves final citation/code markup', () => {
		const renders: MarkdownStreamRender[] = [];
		const scheduler = createMarkdownStreamScheduler((render) => renders.push(render), {
			requestAnimationFrame: undefined
		});
		scheduler.update('Initial answer', false);
		expect(renders).toEqual([{ content: 'Initial answer', partial: false }]);

		const final = prepareAssistantMarkdown('Claim [1].\n\n```ts\nconst ready = true;\n```');
		const html = renderMarkdownToHtml(final);
		expect(html).toContain('[1]');
		expect(html).toContain('<pre><code class="language-ts">');
		expect(html).toContain('const ready = true;');
	});
});
