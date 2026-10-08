import { EXPECTED_MIGRATION_COUNT, MIGRATION_TABLE, MIGRATION_VERSIONS } from './migration-contract';

export interface MigrationStatus {
	ok: boolean;
	table: string;
	tableExists: boolean;
	appliedCount?: number;
	latest?: string;
	expectedCount: number;
	error?: string;
}

export interface MigrationStatusClient {
	unsafe<T extends Record<string, unknown>[]>(query: string): PromiseLike<T>;
}

/** Inspect the application contract without running DDL or exposing database errors. */
export async function getMigrationStatus(client: MigrationStatusClient): Promise<MigrationStatus> {
	try {
		const [table] = await client.unsafe<Array<{ name: string | null }>>(
			`SELECT to_regclass('public.${MIGRATION_TABLE}')::text AS name`
		);
		if (!table?.name) return missingMigrationStatus('Migration table is not initialized');
		const rows = await client.unsafe<Array<{ version: string }>>(
			`SELECT version FROM "${MIGRATION_TABLE}" ORDER BY version`
		);
		const versions = new Set(rows.map(({ version }) => version));
		const complete = rows.length === EXPECTED_MIGRATION_COUNT
			&& versions.size === EXPECTED_MIGRATION_COUNT
			&& MIGRATION_VERSIONS.every(version => versions.has(version));
		return {
			ok: complete,
			table: MIGRATION_TABLE,
			tableExists: true,
			appliedCount: rows.length,
			latest: [...versions].sort().at(-1),
			expectedCount: EXPECTED_MIGRATION_COUNT,
			...(complete ? {} : { error: 'Schema migrations are incomplete' })
		};
	} catch {
		return missingMigrationStatus('Migration status query failed');
	}
}

export function missingMigrationStatus(error: string): MigrationStatus {
	return {
		ok: false,
		table: MIGRATION_TABLE,
		tableExists: false,
		appliedCount: 0,
		latest: MIGRATION_VERSIONS[0],
		expectedCount: EXPECTED_MIGRATION_COUNT,
		error
	};
}
