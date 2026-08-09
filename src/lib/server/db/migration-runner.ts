import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
	LEGACY_MIGRATION_COUNT,
	MIGRATION_TABLE,
	MIGRATION_VERSIONS,
	REQUIRED_SCHEMA_COLUMNS,
	REQUIRED_SCHEMA_TABLES
} from './migration-contract';

export interface MigrationClient {
	unsafe<T = unknown>(query: string, values?: unknown[]): Promise<T>;
	begin<T>(callback: (transaction: MigrationClient) => Promise<T>): Promise<T>;
}

export interface MigrationRunResult {
	applied: string[];
	baseline: boolean;
	latest: string;
}

const MIGRATION_FILES = MIGRATION_VERSIONS.map((version) => `${version}.sql`);
const MIGRATION_DIRECTORY = fileURLToPath(new URL('../../../../drizzle/', import.meta.url));
const BREAKPOINT = /^\s*--> statement-breakpoint\s*$/m;

export function splitMigrationStatements(sql: string): string[] {
	return sql
		.split(BREAKPOINT)
		.map((statement) => statement.trim())
		.filter(Boolean);
}

async function migrationStatements(fileName: string): Promise<string[]> {
	const contents = await readFile(`${MIGRATION_DIRECTORY}${fileName}`, 'utf8');
	return splitMigrationStatements(contents);
}

function requiredTableList(): string {
	return REQUIRED_SCHEMA_TABLES.map((table) => `'${table}'`).join(', ');
}

function requiredColumnList(): string {
	return [...new Set(Object.values(REQUIRED_SCHEMA_COLUMNS).flat())]
		.map((column) => `'${column}'`)
		.join(', ');
}

async function existingSchemaTables(transaction: MigrationClient): Promise<Set<string>> {
	const rows = await transaction.unsafe<Array<{ table_name: string }>>(
		`SELECT table_name
		 FROM information_schema.tables
		 WHERE table_schema = 'public'
		   AND table_name IN (${requiredTableList()})`
	);
	return new Set(rows.map((row) => row.table_name));
}

async function existingSchemaColumns(transaction: MigrationClient): Promise<Set<string>> {
	const rows = await transaction.unsafe<Array<{ table_name: string; column_name: string }>>(
		`SELECT table_name, column_name
		 FROM information_schema.columns
		 WHERE table_schema = 'public'
		   AND table_name IN (${requiredTableList()})
		   AND column_name IN (${requiredColumnList()})`
	);
	return new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
}

async function markLegacySchemaBaseline(transaction: MigrationClient): Promise<boolean> {
	const tables = await existingSchemaTables(transaction);
	if (tables.size === 0) return false;
	const missing = REQUIRED_SCHEMA_TABLES.filter((table) => !tables.has(table));
	if (missing.length) {
		throw new Error(
			`Refusing to guess the state of a partially initialized database. Missing schema tables: ${missing.join(', ')}. Run the explicit migration command after inspecting this database.`
		);
	}
	const columns = await existingSchemaColumns(transaction);
	const missingColumns = Object.entries(REQUIRED_SCHEMA_COLUMNS).flatMap(([table, required]) =>
		required.filter((column) => !columns.has(`${table}.${column}`)).map((column) => `${table}.${column}`)
	);
	if (missingColumns.length) {
		throw new Error(
			`Refusing to baseline a database with an incomplete legacy schema. Missing required columns: ${missingColumns.join(', ')}. Run the explicit migration command after inspecting this database.`
		);
	}

	for (const version of MIGRATION_VERSIONS.slice(0, LEGACY_MIGRATION_COUNT)) {
		await transaction.unsafe(
			`INSERT INTO ${MIGRATION_TABLE} (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
			[version]
		);
	}
	return true;
}

/**
 * Run schema changes only from an explicit migration/bootstrapping command.
 * The transaction-scoped advisory lock serializes cold starts and makes the
 * migration table the durable source of truth for every process.
 */
export async function runMigrations(
	client: MigrationClient,
	options: { appPasswordHash?: string } = {}
): Promise<MigrationRunResult> {
	return client.begin(async (transaction) => {
		await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext('newscraft-ai:schema'))");
		await transaction.unsafe(
			`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
				version text PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`
		);

		const rows = await transaction.unsafe<Array<{ version: string }>>(
			`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`
		);
		const applied = new Set(rows.map((row) => row.version));
		let baseline = false;
		if (applied.size === 0) baseline = await markLegacySchemaBaseline(transaction);

		const newlyApplied: string[] = [];
		for (const [index, version] of MIGRATION_VERSIONS.entries()) {
			if (applied.has(version)) continue;
			const statements = await migrationStatements(MIGRATION_FILES[index]);
			for (const statement of statements) await transaction.unsafe(statement);
			await transaction.unsafe(
				`INSERT INTO ${MIGRATION_TABLE} (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
				[version]
			);
			newlyApplied.push(version);
		}

		if (options.appPasswordHash) {
			await transaction.unsafe(
				`INSERT INTO settings (key, value)
				 VALUES ('auth.password_hash', $1)
				 ON CONFLICT (key) DO NOTHING`,
				[options.appPasswordHash]
			);
		}

		return {
			applied: newlyApplied,
			baseline,
			latest: MIGRATION_VERSIONS[MIGRATION_VERSIONS.length - 1]
		};
	});
}
