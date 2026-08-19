import { describe, expect, it } from 'vitest';

import { SerialTaskQueue } from './serial-task-queue';

describe('SerialTaskQueue', () => {
	it('reserves order before concurrent callers can start', async () => {
		const queue = new SerialTaskQueue();
		const events: string[] = [];
		let releaseFirst!: () => void;
		let noteFirstStarted!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			noteFirstStarted = resolve;
		});

		const first = queue.enqueue(async () => {
			events.push('first:start');
			noteFirstStarted();
			await firstGate;
			events.push('first:end');
		});
		const second = queue.enqueue(async () => {
			events.push('second:start');
		});

		await firstStarted;
		expect(events).toEqual(['first:start']);
		releaseFirst();
		await Promise.all([first, second]);
		expect(events).toEqual(['first:start', 'first:end', 'second:start']);
	});

	it('releases the next task after a failure', async () => {
		const queue = new SerialTaskQueue();
		const first = queue.enqueue(async () => {
			throw new Error('first failed');
		});
		const second = queue.enqueue(async () => 'second completed');

		await expect(first).rejects.toThrow('first failed');
		await expect(second).resolves.toBe('second completed');
	});
});
