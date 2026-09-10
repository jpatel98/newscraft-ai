import { describe, expect, it } from 'vitest';
import { createMarkdownStreamScheduler, type MarkdownStreamRender } from './markdown-stream-scheduler';
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
