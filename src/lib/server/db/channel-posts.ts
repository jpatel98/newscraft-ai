import { asc, eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { hermesChannelPosts } from './schema';

export interface ChannelPostUpsertInput {
	id: string;
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

export function listChannelPosts(): ChannelPostRow[] {
	try {
		return db.select().from(hermesChannelPosts).orderBy(asc(hermesChannelPosts.updatedAt)).all();
	} catch (err) {
		if (missingChannelPostsTable(err)) return [];
		throw err;
	}
}

export function clearAllChannelPosts(): void {
	try {
		db.delete(hermesChannelPosts).run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function deleteChannelPostsByJobIds(jobIds: string[]): void {
	const ids = jobIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) return;
	try {
		db.delete(hermesChannelPosts).where(inArray(hermesChannelPosts.jobId, ids)).run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function deleteChannelPostsByJobId(jobId: string): void {
	const id = jobId.trim();
	if (!id) return;
	try {
		db.delete(hermesChannelPosts).where(eq(hermesChannelPosts.jobId, id)).run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}

export function renameChannelPostsForJob(jobId: string, channelName: string): void {
	const id = jobId.trim();
	const name = channelName.trim();
	if (!id || !name) return;
	try {
		db.update(hermesChannelPosts).set({ channel: name, updatedAt: Date.now() }).where(eq(hermesChannelPosts.jobId, id)).run();
	} catch (err) {
		if (missingChannelPostsTable(err)) return;
		throw err;
	}
}
