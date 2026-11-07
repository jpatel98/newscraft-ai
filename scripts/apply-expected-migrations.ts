/**
 * Apply exactly the named pending migrations and nothing else.
 *
 *   pnpm --filter @newscraft/newsroom-harness exec tsx ../../scripts/apply-expected-migrations.ts \
 *     --expect 0027_project_evidence
 *
 * The connection comes from DATABASE_URL, or from PGHOST/PGPORT/PGDATABASE/
 * PGUSER/PGPASSWORD when the password is awkward inside a URL. `runMigrations`
 * refuses when the pending set differs from --expect or the ledger holds
 * unknown versions, so a stale checkout or a surprising database aborts
 * before any DDL. Nothing secret is printed.
 */
import postgres from 'postgres';
import { runMigrations, type MigrationClient } from '../src/lib/server/db/migration-runner';

const expected: string[] = [];
for (let index = 2; index < process.argv.length; index += 1) {
	if (process.argv[index] === '--expect' && process.argv[index + 1]) expected.push(process.argv[++index]);
	else throw new Error(`Unknown argument: ${process.argv[index]}`);
}
if (expected.length === 0) throw new Error('Pass at least one --expect <migration_version>.');

const options = { prepare: false as const, onnotice: () => {}, max: 1 };
const client = process.env.DATABASE_URL
	? postgres(process.env.DATABASE_URL, options)
	: postgres({
			host: process.env.PGHOST || '127.0.0.1',
			port: Number(process.env.PGPORT || '5432'),
			database: process.env.PGDATABASE || 'newscraft',
			username: process.env.PGUSER,
			password: process.env.PGPASSWORD,
			...options
		});
if (!process.env.DATABASE_URL && (!process.env.PGUSER || !process.env.PGPASSWORD)) {
	throw new Error('Set DATABASE_URL, or PGUSER and PGPASSWORD.');
}

try {
	const [before] = await client`SELECT count(*)::int AS count FROM newscraft_schema_migrations`;
	const result = await runMigrations(client as unknown as MigrationClient, { expectedPending: expected });
	const [after] = await client`SELECT count(*)::int AS count FROM newscraft_schema_migrations`;
	const tables = await client`SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name LIKE 'project\\_%' ORDER BY table_name`;
	const grants = await client`SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
		FROM information_schema.role_table_grants WHERE grantee = 'newscraft_app' AND table_name LIKE 'project\\_%'
		GROUP BY table_name ORDER BY table_name`;
	const rls = await client`SELECT relname, relrowsecurity FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
		WHERE nspname = 'public' AND relname LIKE 'project\\_%' AND relkind = 'r' ORDER BY relname`;
	console.log(JSON.stringify({
		ledgerBefore: before.count,
		applied: result.applied,
		latest: result.latest,
		ledgerAfter: after.count,
		projectTables: tables.map((row) => row.table_name),
		appRoleGrants: grants,
		rowLevelSecurity: rls
	}, null, 2));
} finally {
	await client.end({ timeout: 5 });
}
