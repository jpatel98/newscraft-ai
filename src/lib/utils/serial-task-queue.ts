export class SerialTaskQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.catch(() => {}).then(task);
		this.tail = run.then(
			() => {},
			() => {}
		);
		return run;
	}
}
