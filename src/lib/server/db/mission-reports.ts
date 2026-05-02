import { asc, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { hermesChannelPosts, missionReports } from './schema';

export interface MissionReportUpsertInput {
	id: string;
	missionId: string;
	missionName: string;
	runTime: string | null;
	schedule: string | null;
	filename: string;
	filePathDisplay: string;
	responseMarkdown: string;
	preview: string;
	sourceMtimeMs: number;
	outputFormat?: string;
	legacyChannelPostId?: string | null;
}

export interface MissionReportRow {
	id: string;
	missionId: string;
	missionName: string;
	runTime: string | null;
	schedule: string | null;
	filename: string;
	filePathDisplay: string;
	outputFormat: string;
	responseMarkdown: string;
	preview: string;
	sourceMtimeMs: number;
	legacyChannelPostId: string | null;
	createdAt: number;
	updatedAt: number;
}

function missingMissionReportsTable(err: unknown): boolean {
	return err instanceof Error && /no such table:\s*mission_reports/i.test(err.message);
}

function missingLegacyPostsTable(err: unknown): boolean {
	return err instanceof Error && /no such table:\s*hermes_channel_posts/i.test(err.message);
}

function legacyReportRows(): MissionReportRow[] {
	try {
		return db
			.select()
			.from(hermesChannelPosts)
			.orderBy(asc(hermesChannelPosts.updatedAt))
			.all()
			.map((row) => ({
				id: row.id,
				missionId: row.jobId,
				missionName: row.channel,
				runTime: row.runTime,
				schedule: row.schedule,
				filename: row.filename,
				filePathDisplay: row.filePathDisplay,
				outputFormat: 'markdown',
				responseMarkdown: row.responseMarkdown,
				preview: row.preview,
				sourceMtimeMs: row.sourceMtimeMs,
				legacyChannelPostId: row.id,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt
			}));
	} catch (err) {
		if (missingLegacyPostsTable(err)) return [];
		throw err;
	}
}

export function upsertMissionReport(input: MissionReportUpsertInput): void {
	const now = Date.now();
	const sourceMtimeMs = Math.max(0, Math.round(input.sourceMtimeMs));
	try {
		db.insert(missionReports)
			.values({
				id: input.id,
				missionId: input.missionId,
				missionName: input.missionName,
				runTime: input.runTime,
				schedule: input.schedule,
				filename: input.filename,
				filePathDisplay: input.filePathDisplay,
				outputFormat: input.outputFormat ?? 'markdown',
				responseMarkdown: input.responseMarkdown,
				preview: input.preview,
				sourceMtimeMs,
				legacyChannelPostId: input.legacyChannelPostId ?? null,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: missionReports.id,
				set: {
					missionId: input.missionId,
					missionName: input.missionName,
					runTime: input.runTime,
					schedule: input.schedule,
					filename: input.filename,
					filePathDisplay: input.filePathDisplay,
					outputFormat: input.outputFormat ?? 'markdown',
					responseMarkdown: input.responseMarkdown,
					preview: input.preview,
					sourceMtimeMs,
					legacyChannelPostId: input.legacyChannelPostId ?? null,
					updatedAt: now
				}
			})
			.run();
	} catch (err) {
		if (missingMissionReportsTable(err)) return;
		throw err;
	}
}

export function listMissionReports(): MissionReportRow[] {
	try {
		const rows = db.select().from(missionReports).orderBy(asc(missionReports.updatedAt)).all();
		if (rows.length > 0) return rows;
		return legacyReportRows();
	} catch (err) {
		if (missingMissionReportsTable(err)) return legacyReportRows();
		throw err;
	}
}

export function clearAllMissionReports(): void {
	try {
		db.delete(missionReports).run();
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}

export function deleteMissionReportsByMissionIds(missionIds: string[]): void {
	const ids = missionIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) return;
	try {
		db.delete(missionReports).where(inArray(missionReports.missionId, ids)).run();
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}

export function deleteMissionReportsByMissionId(missionId: string): void {
	const id = missionId.trim();
	if (!id) return;
	try {
		db.delete(missionReports).where(eq(missionReports.missionId, id)).run();
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}

export function renameMissionReportsForMission(missionId: string, missionName: string): void {
	const id = missionId.trim();
	const name = missionName.trim();
	if (!id || !name) return;
	try {
		db.update(missionReports)
			.set({ missionName: name, updatedAt: Date.now() })
			.where(eq(missionReports.missionId, id))
			.run();
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}
