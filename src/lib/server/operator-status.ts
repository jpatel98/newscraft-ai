import { boardData } from '$lib/server/hermes/board';
import { gatewayHealth } from '$lib/server/hermes/transport';
import { getMaintenanceStatus } from '$lib/server/db/maintenance';
import type { BoardData, BoardPost, HermesRun, OperatorFooterStatus } from '$lib/types';

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'pending', 'scheduled', 'started', 'in_progress', 'active']);
const SUCCESS_RUN_STATUSES = new Set(['completed', 'complete', 'ok', 'success']);

function parsedTime(value: string | null | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function latestRunTime(run: HermesRun): number {
	return Math.max(parsedTime(run.completedAt), parsedTime(run.startedAt), parsedTime(run.updatedAt), parsedTime(run.queuedAt));
}

function latestPostTime(post: BoardPost): number {
	return parsedTime(post.runTime);
}

function latestSuccessfulMissionRun(data: BoardData): OperatorFooterStatus['lastSuccessfulMissionRun'] {
	const successfulRun = [...(data.runs ?? [])]
		.filter((run) => SUCCESS_RUN_STATUSES.has(run.status.toLowerCase()))
		.sort((a, b) => latestRunTime(b) - latestRunTime(a))[0];

	if (successfulRun) {
		const at =
			successfulRun.completedAt ??
			successfulRun.startedAt ??
			successfulRun.updatedAt ??
			successfulRun.queuedAt ??
			null;
		return {
			at,
			label: at ? 'Recorded' : 'Run recorded',
			missionName: successfulRun.jobName ?? data.jobs.find((job) => job.id === successfulRun.jobId)?.name ?? null
		};
	}

	const latestReport = [...data.posts].sort((a, b) => latestPostTime(b) - latestPostTime(a))[0];
	if (latestReport?.runTime) {
		return {
			at: latestReport.runTime,
			label: 'Report saved',
			missionName: latestReport.channel || null
		};
	}

	return {
		at: null,
		label: 'No successful runs',
		missionName: null
	};
}

function pendingJobs(data: BoardData): OperatorFooterStatus['pendingJobs'] {
	const activeRuns = (data.runs ?? []).filter((run) => ACTIVE_RUN_STATUSES.has(run.status.toLowerCase()));
	const activeJobIds = new Set(activeRuns.map((run) => run.jobId));
	return {
		count: activeJobIds.size,
		label: activeJobIds.size === 1 ? '1 pending job' : `${activeJobIds.size} pending jobs`
	};
}

export async function getOperatorFooterStatus(accountId: string): Promise<OperatorFooterStatus> {
	const [gateway, maintenance, board] = await Promise.all([
		gatewayHealth(),
		getMaintenanceStatus(),
		boardData(accountId, { includeResponseMarkdown: false })
	]);
	const latestBackup = maintenance.backups.latest;
	const backupOk = maintenance.backups.directory.exists && !maintenance.backups.error && Boolean(latestBackup);
	const hermesAvailable = gateway.ok && !board.jobsError;

	return {
		ok: gateway.ok && hermesAvailable && backupOk,
		generatedAt: new Date().toISOString(),
		gateway: {
			ok: gateway.ok,
			status: gateway.status,
			label: gateway.ok ? `HTTP ${gateway.status}` : 'Offline',
			detail: gateway.ok ? null : gateway.body || null
		},
		hermes: {
			available: hermesAvailable,
			label: hermesAvailable ? 'Available' : 'Unavailable',
			detail: board.jobsError ?? (!gateway.ok ? gateway.body : null)
		},
		lastSuccessfulMissionRun: latestSuccessfulMissionRun(board),
		dbBackup: {
			ok: backupOk,
			label: latestBackup ? 'Backed up' : maintenance.backups.error ? 'Backup error' : 'No backup',
			latestAt: latestBackup?.modifiedAt ?? null,
			count: maintenance.backups.count,
			detail: maintenance.backups.error ?? null
		},
		pendingJobs: pendingJobs(board)
	};
}
