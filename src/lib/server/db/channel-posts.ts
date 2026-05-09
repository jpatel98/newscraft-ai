import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { hermesChannelPosts } from './schema';

export interface ChannelPostUpsertInput {
	id: string;
	accountId: string;
	jobId: string;
	channel: string;
	runTime: string | null;
	schedule: string | null;
	filename: string;
	filePathDisplay: string;
	responseMarkdown: string;
	preview: string;
	sourceMtimeMs: number;
}

export interface ChannelPostRow {
	id: string;
	accountId: string;
	jobId: string;
	channel: string;
	runTime: string | null;
	schedule: string | null;
	filename: string;
	filePathDisplay: string;
	responseMarkdown: string;
	preview: string;
	sourceMtimeMs: number;
	createdAt: number;
	updatedAt: number;
}

function missingChannelPostsTable(err: unknown): boolean {
	return (
		err instanceof Error &&
		/no such table:\s*hermes_channel_posts/i.test(err.message)
	);
}

export function upsertChannelPost(input: ChannelPostUpsertInput): void {
	const now = Date.now();
	try {
		db.insert(hermesChannelPosts)
			.values({
				id: input.id,
				accountId: input.accountId,
				jobId: input.jobId,
				channel: input.channel,
				runTime: input.runTime,
				schedule: input.schedule,
				filename: input.filename,
				filePathDisplay: input.filePathDisplay,
				responseMarkdown: input.responseMarkdown,
				preview: input.preview,
				sourceMtimeMs: Math.max(0, Math.round(input.sourceMtimeMs)),
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: hermesChannelPosts.id,
				set: {
					jobId: input.jobId,
					accountId: input.accountId,
					channel: input.channel,
					runTime: input.runTime,
					schedule: input.schedule,
					filename: input.filename,
					filePathDisplay: input.filePathDisplay,
					responseMarkdown: input.responseMarkdown,
					preview: input.preview,
					sourceMtimeMs: Math.max(0, Math.round(input.sourceMtimeMs)),
					updatedAt: now
				}
			})
			.run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function listChannelPosts(accountId: string): ChannelPostRow[] {
	try {
		return db
			.select()
			.from(hermesChannelPosts)
			.where(eq(hermesChannelPosts.accountId, accountId))
			.orderBy(asc(hermesChannelPosts.updatedAt))
			.all();
	} catch (err) {
		if (missingChannelPostsTable(err)) return [];
		throw err;
	}
}

export function clearAllChannelPosts(accountId: string): void {
	try {
		db.delete(hermesChannelPosts).where(eq(hermesChannelPosts.accountId, accountId)).run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function deleteChannelPostsByJobIds(accountId: string, jobIds: string[]): void {
	const ids = jobIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) return;
	try {
		db.delete(hermesChannelPosts)
			.where(and(eq(hermesChannelPosts.accountId, accountId), inArray(hermesChannelPosts.jobId, ids)))
			.run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function deleteChannelPostsByJobId(accountId: string, jobId: string): void {
	const id = jobId.trim();
	if (!id) return;
	try {
		db.delete(hermesChannelPosts)
			.where(and(eq(hermesChannelPosts.accountId, accountId), eq(hermesChannelPosts.jobId, id)))
			.run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function renameChannelPostsForJob(accountId: string, jobId: string, channelName: string): void {
	const id = jobId.trim();
	const name = channelName.trim();
	if (!id || !name) return;
	try {
		db.update(hermesChannelPosts)
			.set({ channel: name, updatedAt: Date.now() })
			.where(and(eq(hermesChannelPosts.accountId, accountId), eq(hermesChannelPosts.jobId, id)))
			.run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}
