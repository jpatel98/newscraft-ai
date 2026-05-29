import type { NewsroomJobDto, NewsroomRunDto } from '@newscraft/shared';
import type { HarnessConfig } from '../config.js';
import type { HarnessRepository } from '../db/repository.js';
import type { NewsroomAgentRuntime, RuntimeProgressEvent } from '../agents/runtime.js';
import { hasBeatMonitorInputs, runBeatMonitor } from '../agents/beat-monitor.js';
import { nowIso } from '../util/ids.js';
import { beatMonitorReportMarkdown, postReportToUi, wrapMissionReport } from './report.js';

export class JobRunner {
	private active = new Map<string, Promise<void>>();

	constructor(
		private repository: HarnessRepository,
		private runtime: NewsroomAgentRuntime,
		private config: HarnessConfig
	) {}

	start(jobId: string, trigger: 'manual' | 'schedule' | 'test' = 'manual', workspaceId?: string): NewsroomRunDto {
		this.clearStaleActiveRuns();
		if (this.repository.hasActiveRun(jobId)) {
			return this.repository
				.listRuns({ includeCompleted: false })
				.find((run) => run.job_id === jobId) as NewsroomRunDto;
		}
		if (workspaceId) this.repository.updateJob(jobId, { workspace_id: workspaceId });
		const run = this.repository.createRun(jobId, trigger);
		const execution = this.execute(run.id, workspaceId).finally(() => this.active.delete(run.id));
		this.active.set(run.id, execution);
		return run;
	}

	async waitFor(runId: string): Promise<void> {
		await this.active.get(runId);
	}

	clearStaleActiveRuns(): number {
		const staleAgeMs = Math.max(this.config.runTimeoutMs * 2, 10 * 60_000);
		const cutoff = new Date(Date.now() - staleAgeMs).toISOString();
		return this.repository.failStaleActiveRuns(cutoff, 'Run marked failed because the runner no longer has active execution for it.');
	}

	private async execute(runId: string, workspaceId?: string): Promise<void> {
		const startedAt = nowIso();
		let run = this.repository.updateRun(runId, { status: 'running', started_at: startedAt, last_error: null });
		const job = this.repository.requireJob(run.job_id);
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), this.config.runTimeoutMs);

		try {
			if (hasBeatMonitorInputs(this.repository, job)) {
				this.repository.addRunStep(run.id, 'beat_monitor', 'Read Standing Brief sources and approved Crawl Plans');
				const result = await runBeatMonitor(this.repository, job, { runId: run.id, workspaceId }, { signal: abort.signal });
				this.repository.addRunStep(run.id, 'beat_monitor', 'Queue pitch gates for editor review', 'completed', {
					sourceCount: result.sourceCount,
					pitchCount: result.pitchCount,
					gateIds: result.gates.map((gate) => gate.id)
				});
				this.repository.addRunStep(run.id, 'production', 'Write mission report');
				const completedAt = nowIso();
				await this.saveReport(job, run.id, beatMonitorReportMarkdown(job, result), completedAt);
				run = this.repository.updateRun(run.id, {
					status: 'completed',
					completed_at: completedAt,
					elapsed_ms: Date.parse(completedAt) - Date.parse(startedAt)
				});
				this.repository.completeJobSchedule(run.job_id);
				return;
			}
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
			await this.saveReport(job, run.id, result.markdown, completedAt);
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

	private async saveReport(job: NewsroomJobDto, runId: string, markdown: string, completedAt: string): Promise<void> {
		const wrapped = wrapMissionReport(job, markdown, completedAt);
		const report = this.repository.createReport({
			runId,
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
			metadata: source.metadata ?? null,
			provenance: source.provenance ?? null,
			healthGate: source.healthGate ?? null
		});
	}
}
