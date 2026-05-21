import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ChannelSource, HermesJob } from '$lib/types';
import { newId } from '$lib/utils/id';
import { normalizeChannelSource, overlayChannelSourceConfigs } from '$lib/utils/channel-sources';
import { db } from './index';
import { hermesChannelConfigs, hermesChannelSources, missions, missionSources } from './schema';

export interface MissionConfig {
	missionId: string;
	basePrompt: string;
	description: string;
	outputFormat: string;
	sources: ChannelSource[];
}

function missingMissionTables(err: unknown): boolean {
	return err instanceof Error && /(no such table:\s*mission(s|_sources)?|relation "mission(s|_sources)?" does not exist)/i.test(err.message);
}

function missingLegacyTables(err: unknown): boolean {
	return err instanceof Error && /(no such table:\s*hermes_channel_(configs|sources)|relation "hermes_channel_(configs|sources)" does not exist)/i.test(err.message);
}

function sourceFromRow(row: typeof missionSources.$inferSelect): ChannelSource | null {
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

function legacySourceFromRow(row: typeof hermesChannelSources.$inferSelect): ChannelSource | null {
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

function sourcesByMissionId(rows: Array<typeof missionSources.$inferSelect>): Map<string, ChannelSource[]> {
	const sources = new Map<string, ChannelSource[]>();
	for (const row of rows) {
		const source = sourceFromRow(row);
		if (!source) continue;
		const list = sources.get(row.missionId) ?? [];
		list.push(source);
		sources.set(row.missionId, list);
	}
	for (const list of sources.values()) {
		list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
	}
	return sources;
}

async function legacyConfigs(accountId: string, missionIds: string[]): Promise<Map<string, MissionConfig>> {
	const ids = Array.from(new Set(missionIds.map((id) => id.trim()).filter(Boolean)));
	const configs = new Map<string, MissionConfig>();
	if (ids.length === 0) return configs;
	try {
		const configRows = await db
			.select()
			.from(hermesChannelConfigs)
			.where(and(eq(hermesChannelConfigs.accountId, accountId), inArray(hermesChannelConfigs.jobId, ids)));
		if (configRows.length === 0) return configs;
		const sourceRows = await db
			.select()
			.from(hermesChannelSources)
			.where(inArray(hermesChannelSources.jobId, ids))
			.orderBy(asc(hermesChannelSources.sortOrder), asc(hermesChannelSources.name));
		const sources = new Map<string, ChannelSource[]>();
		for (const row of sourceRows) {
			const source = legacySourceFromRow(row);
			if (!source) continue;
			const list = sources.get(row.jobId) ?? [];
			list.push(source);
			sources.set(row.jobId, list);
		}
		for (const row of configRows) {
			configs.set(row.jobId, {
				missionId: row.jobId,
				basePrompt: row.basePrompt,
				description: '',
				outputFormat: 'markdown',
				sources: sources.get(row.jobId) ?? []
			});
		}
		return configs;
	} catch (err) {
		if (missingLegacyTables(err)) return configs;
		throw err;
	}
}

export async function getMissionConfig(accountId: string, missionId: string): Promise<MissionConfig | null> {
	const id = missionId.trim();
	if (!id) return null;
	try {
		const [config] = await db
			.select()
			.from(missions)
			.where(and(eq(missions.accountId, accountId), eq(missions.id, id)))
			.limit(1);
		if (!config) return (await legacyConfigs(accountId, [id])).get(id) ?? null;
		const sourceRows = await db
			.select()
			.from(missionSources)
			.where(eq(missionSources.missionId, id))
			.orderBy(asc(missionSources.sortOrder), asc(missionSources.name));
		return {
			missionId: id,
			basePrompt: config.prompt,
			description: config.description,
			outputFormat: config.outputFormat,
			sources: sourceRows.map(sourceFromRow).filter((source: ChannelSource | null): source is ChannelSource => Boolean(source))
		};
	} catch (err) {
		if (missingMissionTables(err)) return (await legacyConfigs(accountId, [id])).get(id) ?? null;
		throw err;
	}
}

export async function getMissionAccountId(missionId: string): Promise<string | null> {
	const id = missionId.trim();
	if (!id) return null;
	try {
		const [row] = await db
			.select({ accountId: missions.accountId })
			.from(missions)
			.where(eq(missions.id, id))
			.limit(1);
		return row?.accountId ?? null;
	} catch (err) {
		if (missingMissionTables(err)) return null;
		throw err;
	}
}

export async function listMissionConfigs(accountId: string, missionIds: string[]): Promise<Map<string, MissionConfig>> {
	const ids = Array.from(new Set(missionIds.map((id) => id.trim()).filter(Boolean)));
	const configs = new Map<string, MissionConfig>();
	if (ids.length === 0) return configs;
	try {
		const missionRows = await db
			.select()
			.from(missions)
			.where(and(eq(missions.accountId, accountId), inArray(missions.id, ids)));
		const sourceRows =
			missionRows.length > 0
				? await db
						.select()
						.from(missionSources)
						.where(inArray(missionSources.missionId, ids))
						.orderBy(asc(missionSources.sortOrder), asc(missionSources.name))
				: [];
		const sources = sourcesByMissionId(sourceRows);
		for (const row of missionRows) {
			configs.set(row.id, {
				missionId: row.id,
				basePrompt: row.prompt,
				description: row.description,
				outputFormat: row.outputFormat,
				sources: sources.get(row.id) ?? []
			});
		}
		for (const [id, config] of await legacyConfigs(accountId, ids)) {
			if (!configs.has(id)) configs.set(id, config);
		}
		return configs;
	} catch (err) {
		if (missingMissionTables(err)) return await legacyConfigs(accountId, ids);
		throw err;
	}
}

export async function overlayMissionConfigs(accountId: string, jobs: HermesJob[]): Promise<HermesJob[]> {
	const configs = await listMissionConfigs(accountId, jobs.map((job) => job.id));
	return overlayChannelSourceConfigs(jobs, configs).map((job) => {
		const config = configs.get(job.id);
		if (!config) return job;
		return {
			...job,
			description: config.description,
			outputFormat: config.outputFormat
		};
	});
}

export async function saveMissionConfig(
	accountId: string,
	missionId: string,
	basePrompt: string,
	sources: ChannelSource[],
	options: {
		name?: string;
		description?: string;
		schedule?: string;
		enabled?: boolean;
		deliveryTarget?: string | null;
		outputFormat?: string;
	} = {}
): Promise<void> {
	const id = missionId.trim();
	if (!id) return;
	const now = Date.now();
	try {
		await db.transaction(async (tx: any) => {
			await tx.insert(missions)
				.values({
					id,
					accountId,
					name: options.name?.trim() || id,
					description: options.description?.trim() || '',
					prompt: basePrompt,
					schedule: options.schedule?.trim() || '',
					enabled: options.enabled === false ? 0 : 1,
					deliveryTarget: options.deliveryTarget?.trim() || 'database',
					outputFormat: options.outputFormat?.trim() || 'markdown',
					backendJobId: id,
					createdAt: now,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: missions.id,
					set: {
						name: options.name?.trim() || id,
						accountId,
						description: options.description?.trim() || '',
						prompt: basePrompt,
						schedule: options.schedule?.trim() || '',
						enabled: options.enabled === false ? 0 : 1,
						deliveryTarget: options.deliveryTarget?.trim() || 'database',
						outputFormat: options.outputFormat?.trim() || 'markdown',
						updatedAt: now
					}
				});

			await tx.delete(missionSources).where(eq(missionSources.missionId, id));

			const sourceIds = new Set<string>();
			for (const [index, source] of sources.entries()) {
				const requestedId = source.id.trim();
				const sourceId = requestedId && !sourceIds.has(requestedId) ? requestedId : newId();
				sourceIds.add(sourceId);
				await tx.insert(missionSources)
					.values({
						id: sourceId,
						missionId: id,
						type: 'url',
						name: source.name,
						configJson: JSON.stringify({ url: source.url }),
						enabled: source.enabled ? 1 : 0,
						sortOrder: index,
						createdAt: now,
						updatedAt: now
					});
			}
		});
	} catch (err) {
		if (missingMissionTables(err)) return;
		throw err;
	}
}

export async function deleteMissionConfig(accountId: string, missionId: string): Promise<void> {
	const id = missionId.trim();
	if (!id) return;
	try {
		await db.delete(missions).where(and(eq(missions.accountId, accountId), eq(missions.id, id)));
	} catch (err) {
		if (!missingMissionTables(err)) throw err;
	}
}

export async function clearAllMissionConfigs(accountId: string): Promise<void> {
	try {
		await db.delete(missions).where(eq(missions.accountId, accountId));
	} catch (err) {
		if (!missingMissionTables(err)) throw err;
	}
}
