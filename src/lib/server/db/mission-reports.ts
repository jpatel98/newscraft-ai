import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, ensureDefaultOrganizationForAccount } from './index';
import { agentChannelPosts, missionReports } from './schema';

export interface MissionReportUpsertInput {
	id: string;
	accountId: string;
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
	accountId: string;
	orgId: string | null;
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

export type MissionReportSummaryRow = Omit<MissionReportRow, 'responseMarkdown'> & {
	responseMarkdown: '';
};

function missingMissionReportsTable(err: unknown): boolean {
	return err instanceof Error && /(no such table:\s*mission_reports|relation "mission_reports" does not exist)/i.test(err.message);
}

function missingLegacyPostsTable(err: unknown): boolean {
	return err instanceof Error && /(no such table:\s*agent_channel_posts|relation "agent_channel_posts" does not exist)/i.test(err.message);
}

async function legacyReportRows(accountId: string): Promise<MissionReportRow[]> {
	try {
		const rows = await db
			.select()
			.from(agentChannelPosts)
			.where(eq(agentChannelPosts.accountId, accountId))
			.orderBy(asc(agentChannelPosts.updatedAt));
		return rows.map((row: typeof agentChannelPosts.$inferSelect) => ({
				id: row.id,
				accountId: row.accountId,
				orgId: null,
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

export async function upsertMissionReport(input: MissionReportUpsertInput): Promise<void> {
	const now = Date.now();
	const sourceMtimeMs = Math.max(0, Math.round(input.sourceMtimeMs));
	const orgId = await ensureDefaultOrganizationForAccount(input.accountId);
	try {
		await db.insert(missionReports)
			.values({
				id: input.id,
				accountId: input.accountId,
				orgId,
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
					accountId: input.accountId,
					orgId,
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
			});
	} catch (err) {
		if (missingMissionReportsTable(err)) return;
		throw err;
	}
}

export async function listMissionReports(accountId: string): Promise<MissionReportRow[]> {
	try {
		const rows = await db
			.select()
			.from(missionReports)
			.where(eq(missionReports.accountId, accountId))
			.orderBy(asc(missionReports.updatedAt));
		if (rows.length > 0) return rows;
		return await legacyReportRows(accountId);
	} catch (err) {
		if (missingMissionReportsTable(err)) return await legacyReportRows(accountId);
		throw err;
	}
}

export async function listMissionReportSummaries(accountId: string): Promise<MissionReportSummaryRow[]> {
	try {
		const rows = await db
			.select({
				id: missionReports.id,
				accountId: missionReports.accountId,
				missionId: missionReports.missionId,
				missionName: missionReports.missionName,
				runTime: missionReports.runTime,
				schedule: missionReports.schedule,
				filename: missionReports.filename,
				filePathDisplay: missionReports.filePathDisplay,
				outputFormat: missionReports.outputFormat,
				preview: missionReports.preview,
				sourceMtimeMs: missionReports.sourceMtimeMs,
				legacyChannelPostId: missionReports.legacyChannelPostId,
				createdAt: missionReports.createdAt,
				updatedAt: missionReports.updatedAt
			})
			.from(missionReports)
			.where(eq(missionReports.accountId, accountId))
			.orderBy(asc(missionReports.updatedAt));
		if (rows.length > 0) {
			return rows.map((row: Omit<MissionReportSummaryRow, 'responseMarkdown'>) => ({ ...row, responseMarkdown: '' }));
		}
		return (await legacyReportRows(accountId)).map(({ responseMarkdown: _responseMarkdown, ...row }) => ({
			...row,
			responseMarkdown: ''
		}));
	} catch (err) {
		if (missingMissionReportsTable(err)) {
			return (await legacyReportRows(accountId)).map(({ responseMarkdown: _responseMarkdown, ...row }) => ({
				...row,
				responseMarkdown: ''
			}));
		}
		throw err;
	}
}

export async function getMissionReport(accountId: string, id: string): Promise<MissionReportRow | undefined> {
	try {
		const [row] = await db
			.select()
			.from(missionReports)
			.where(and(eq(missionReports.accountId, accountId), eq(missionReports.id, id)))
			.limit(1);
		if (row) return row;
		return (await legacyReportRows(accountId)).find((report) => report.id === id);
	} catch (err) {
		if (missingMissionReportsTable(err)) {
			return (await legacyReportRows(accountId)).find((report) => report.id === id);
		}
		throw err;
	}
}

export async function clearAllMissionReports(accountId: string): Promise<void> {
	try {
		await db.delete(missionReports).where(eq(missionReports.accountId, accountId));
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}

export async function deleteMissionReportsByMissionIds(accountId: string, missionIds: string[]): Promise<void> {
	const ids = missionIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) return;
	try {
		await db.delete(missionReports)
			.where(and(eq(missionReports.accountId, accountId), inArray(missionReports.missionId, ids)));
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}

export async function deleteMissionReportsByMissionId(accountId: string, missionId: string): Promise<void> {
	const id = missionId.trim();
	if (!id) return;
	try {
		await db.delete(missionReports)
			.where(and(eq(missionReports.accountId, accountId), eq(missionReports.missionId, id)));
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}

export async function renameMissionReportsForMission(accountId: string, missionId: string, missionName: string): Promise<void> {
	const id = missionId.trim();
	const name = missionName.trim();
	if (!id || !name) return;
	try {
		await db.update(missionReports)
			.set({ missionName: name, updatedAt: Date.now() })
			.where(and(eq(missionReports.accountId, accountId), eq(missionReports.missionId, id)));
	} catch (err) {
		if (!missingMissionReportsTable(err)) throw err;
	}
}
