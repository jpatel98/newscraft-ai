import type { HarnessConfig } from '../config.js';
import type { HarnessRepository } from '../db/repository.js';
import type { JobRunner } from './runner.js';

export class JobScheduler {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private repository: HarnessRepository,
		private runner: JobRunner,
		private config: HarnessConfig
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.config.schedulerIntervalMs);
		this.timer.unref?.();
		void this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	isRunning(): boolean {
		return Boolean(this.timer);
	}

	tick(): void {
		for (const job of this.repository.dueJobs()) {
			if (!this.repository.hasActiveRun(job.id)) this.runner.start(job.id, 'schedule');
		}
	}
}
