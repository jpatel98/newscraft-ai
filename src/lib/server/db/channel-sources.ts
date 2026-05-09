import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ChannelSource, HermesJob } from '$lib/types';
import { newId } from '$lib/utils/id';
import { normalizeChannelSource, overlayChannelSourceConfigs } from '$lib/utils/channel-sources';
import { db } from './index';
import { hermesChannelConfigs, hermesChannelSources } from './schema';

export interface ChannelConfig {
	jobId: string;
	accountId: string;
	basePrompt: string;
	sources: ChannelSource[];
}

function missingChannelSourceTables(err: unknown): boolean {
	return (
		err instanceof Error &&
		/no such table:\s*hermes_channel_(configs|sources)/i.test(err.message)
	);
}

function sourceFromRow(row: typeof hermesChannelSources.$inferSelect): ChannelSource | null {
	try {
		const config = JSON.parse(row.configJson) as { url?: unknown };
		return normalizeChannelSource({
			id: row.id,
			type: row.type,
			name: row.name,
			url: typeof config.url === 'string' ? config.url : '',
			enabled: row.enabled !== 0,
			sortOrder: row.sortOrder
		});
	} catch {
		return null;
	}
}

function sourcesByJobId(rows: Array<typeof hermesChannelSources.$inferSelect>): Map<string, ChannelSource[]> {
	const sources = new Map<string, ChannelSource[]>();
	for (const row of rows) {
		const source = sourceFromRow(row);
		if (!source) continue;
		const list = sources.get(row.jobId) ?? [];
		list.push(source);
		sources.set(row.jobId, list);
	}
	for (const list of sources.values()) {
		list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
	}
	return sources;
}

export function getChannelConfig(accountId: string, jobId: string): ChannelConfig | null {
	const id = jobId.trim();
	if (!id) return null;
	try {
		const config = db
			.select()
			.from(hermesChannelConfigs)
			.where(and(eq(hermesChannelConfigs.accountId, accountId), eq(hermesChannelConfigs.jobId, id)))
			.get();
		if (!config) return null;
		const sourceRows = db
			.select()
			.from(hermesChannelSources)
			.where(eq(hermesChannelSources.jobId, id))
			.orderBy(asc(hermesChannelSources.sortOrder), asc(hermesChannelSources.name))
			.all();
		return {
			jobId: id,
			accountId,
			basePrompt: config.basePrompt,
			sources: sourceRows.map(sourceFromRow).filter((source): source is ChannelSource => Boolean(source))
		};
	} catch (err) {
		if (missingChannelSourceTables(err)) return null;
		throw err;
	}
}

export function listChannelConfigs(accountId: string, jobIds: string[]): Map<string, ChannelConfig> {
	const ids = Array.from(new Set(jobIds.map((id) => id.trim()).filter(Boolean)));
	const configs = new Map<string, ChannelConfig>();
	if (ids.length === 0) return configs;
	try {
		const configRows = db
			.select()
			.from(hermesChannelConfigs)
			.where(and(eq(hermesChannelConfigs.accountId, accountId), inArray(hermesChannelConfigs.jobId, ids)))
			.all();
		if (configRows.length === 0) return configs;
		const sourceRows = db
			.select()
			.from(hermesChannelSources)
			.where(inArray(hermesChannelSources.jobId, ids))
			.orderBy(asc(hermesChannelSources.sortOrder), asc(hermesChannelSources.name))
			.all();
		const sources = sourcesByJobId(sourceRows);
		for (const row of configRows) {
			configs.set(row.jobId, {
				jobId: row.jobId,
				accountId: row.accountId,
				basePrompt: row.basePrompt,
				sources: sources.get(row.jobId) ?? []
			});
		}
		return configs;
	} catch (err) {
		if (missingChannelSourceTables(err)) return configs;
		throw err;
	}
}

export function overlayChannelConfigs(accountId: string, jobs: HermesJob[]): HermesJob[] {
	const configs = listChannelConfigs(accountId, jobs.map((job) => job.id));
	return overlayChannelSourceConfigs(jobs, configs);
}

export function saveChannelConfig(accountId: string, jobId: string, basePrompt: string, sources: ChannelSource[]): void {
	const id = jobId.trim();
	if (!id) return;
	const now = Date.now();
	try {
		db.transaction((tx) => {
			tx.insert(hermesChannelConfigs)
				.values({
					jobId: id,
					accountId,
					basePrompt,
					createdAt: now,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: hermesChannelConfigs.jobId,
					set: {
						accountId,
						basePrompt,
						updatedAt: now
					}
				})
				.run();

			tx.delete(hermesChannelSources).where(eq(hermesChannelSources.jobId, id)).run();

			const sourceIds = new Set<string>();
			for (const [index, source] of sources.entries()) {
				const requestedId = source.id.trim();
				const sourceId = requestedId && !sourceIds.has(requestedId) ? requestedId : newId();
				sourceIds.add(sourceId);
				tx.insert(hermesChannelSources)
					.values({
						id: sourceId,
						jobId: id,
						type: 'url',
						name: source.name,
						configJson: JSON.stringify({ url: source.url }),
						enabled: source.enabled ? 1 : 0,
						sortOrder: index,
						createdAt: now,
						updatedAt: now
					})
					.run();
			}
		});
	} catch (err) {
		if (missingChannelSourceTables(err)) return;
		throw err;
	}
}

export function deleteChannelConfig(accountId: string, jobId: string): void {
	const id = jobId.trim();
	if (!id) return;
	try {
		db.delete(hermesChannelConfigs)
			.where(and(eq(hermesChannelConfigs.accountId, accountId), eq(hermesChannelConfigs.jobId, id)))
			.run();
	} catch (err) {
		if (missingChannelSourceTables(err)) return;
		throw err;
	}
}

export function deleteChannelConfigsByJobIds(accountId: string, jobIds: string[]): void {
	const ids = jobIds.map((id) => id.trim()).filter(Boolean);
	if (ids.length === 0) return;
	try {
		db.delete(hermesChannelConfigs)
			.where(and(eq(hermesChannelConfigs.accountId, accountId), inArray(hermesChannelConfigs.jobId, ids)))
			.run();
	} catch (err) {
		if (missingChannelSourceTables(err)) return;
		throw err;
	}
}

export function clearAllChannelConfigs(accountId: string): void {
	try {
		db.delete(hermesChannelConfigs).where(eq(hermesChannelConfigs.accountId, accountId)).run();
	} catch (err) {
		if (missingChannelSourceTables(err)) return;
		throw err;
	}
}
