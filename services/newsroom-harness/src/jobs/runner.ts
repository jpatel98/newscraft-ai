import type { NewsroomRunDto } from '@newscraft/shared';
import type { HarnessConfig } from '../config.js';
import type { HarnessRepository } from '../db/repository.js';
import type { NewsroomAgentRuntime, RuntimeProgressEvent } from '../agents/runtime.js';
import { nowIso } from '../util/ids.js';
import { postReportToUi, wrapMissionReport } from './report.js';

export class JobRunner {
	private active = new Map<string, Promise<void>>();

	constructor(
		private repository: HarnessRepository,
		private runtime: NewsroomAgentRuntime,
		private config: HarnessConfig
	) {}

	start(jobId: string, trigger: 'manual' | 'schedule' | 'test' = 'manual'): NewsroomRunDto {
		if (this.repository.hasActiveRun(jobId)) {
			return this.repository
				.listRuns({ includeCompleted: false })
				.find((run) => run.job_id === jobId) as NewsroomRunDto;
		}
		const run = this.repository.createRun(jobId, trigger);
		const execution = this.execute(run.id).finally(() => this.active.delete(run.id));
		this.active.set(run.id, execution);
		return run;
	}

	async waitFor(runId: string): Promise<void> {
		await this.active.get(runId);
	}

	private async execute(runId: string): Promise<void> {
		const startedAt = nowIso();
		let run = this.repository.updateRun(runId, { status: 'running', started_at: startedAt, last_error: null });
		const job = this.repository.requireJob(run.job_id);
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), this.config.runTimeoutMs);

		try {
			this.repository.addRunStep(run.id, 'assignment_desk', 'Route mission to newsroom role');
			const result = await this.runtime.runMission(job.prompt || '', {
				repository: this.repository,
				runId: run.id,
				jobId: job.id,
				signal: abort.signal,
				onProgress: (event) => this.recordProgress(run.id, job.id, event)
			});
			this.repository.addRunStep(run.id, result.role, `Completed ${result.role.replace(/_/g, ' ')} pass`, 'completed', {
				sourceCount: result.sources.length
			});
			this.repository.addRunStep(run.id, 'production', 'Write mission report');
			const completedAt = nowIso();
			const wrapped = wrapMissionReport(job, result.markdown, completedAt);
			const report = this.repository.createReport({
				runId: run.id,
				jobId: job.id,
				title: job.name,
				markdown: wrapped.markdown
			});
			try {
				if (this.config.uiIngestUrl && this.config.uiIngestKey) {
					await postReportToUi({
						url: this.config.uiIngestUrl,
						key: this.config.uiIngestKey,
						id: report.id,
						job,
						runTime: completedAt,
						filename: wrapped.filename,
						markdown: wrapped.markdown,
						signal: AbortSignal.timeout(10_000)
					});
					this.repository.updateReportIngest(report.id, 'sent', null);
				}
			} catch (err) {
				this.repository.updateReportIngest(report.id, 'failed', err instanceof Error ? err.message : String(err));
			}
			run = this.repository.updateRun(run.id, {
				status: 'completed',
				completed_at: completedAt,
				elapsed_ms: Date.parse(completedAt) - Date.parse(startedAt)
			});
			this.repository.completeJobSchedule(run.job_id);
		} catch (err) {
			const completedAt = nowIso();
			this.repository.updateRun(run.id, {
				status: 'failed',
				completed_at: completedAt,
				elapsed_ms: Date.parse(completedAt) - Date.parse(startedAt),
				last_error: err instanceof Error ? err.message : String(err)
			});
			this.repository.completeJobSchedule(run.job_id);
		} finally {
			clearTimeout(timeout);
		}
	}

	private recordProgress(runId: string, jobId: string, event: RuntimeProgressEvent): void {
		if (event.type === 'tool') {
			if (event.status === 'running') {
				this.repository.recordToolCall({
					id: event.id,
					runId,
					name: event.name,
					args: { detail: event.detail },
					status: event.status
				});
			} else {
				this.repository.updateToolCall(event.id, {
					status: event.status,
					result: event.result,
					error: event.status === 'failed' ? event.detail || 'tool failed' : null
				});
			}
			return;
		}
		const source = event.source;
		this.repository.storeSource({
			runId,
			jobId,
			url: source.url,
			title: source.title,
			fetchedAt: source.fetchedAt,
			snippet: source.snippet,
			summary: source.summary,
			used: source.used,
			contentText: source.contentText,
			contentHash: source.contentHash,
			contentType: source.contentType,
			statusCode: source.statusCode,
			healthGate: source.healthGate ?? null
		});
	}
}
