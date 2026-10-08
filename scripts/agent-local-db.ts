/** Narrow operator entry point for the already initialized, guarded local database. */
import postgres from 'postgres';
import { resolveLocalSetup } from './agent-local.mjs';
import { runMigrations, type MigrationClient } from '../src/lib/server/db/migration-runner.ts';
import { getMigrationStatus } from '../src/lib/server/db/migration-status.ts';
import { createDatabaseSocketFactory, parseDatabaseUrl } from '../src/lib/server/db/socket.ts';

const operation = process.argv[2];
if (!['inspect', 'apply-topic'].includes(operation) || process.argv.length !== 3) {
	console.error('Usage: pnpm --filter @newscraft/newsroom-harness exec tsx ../../scripts/agent-local-db.ts inspect|apply-topic');
	process.exit(2);
}
const setup = resolveLocalSetup({ provider: 'deepseek' });
if (!setup.report.ok) {
	console.error('Local configuration is blocked. Run the passive DeepSeek setup checker.');
	process.exit(1);
}
const databaseUrl = setup.environment.DATABASE_URL;
const endpoint = parseDatabaseUrl(databaseUrl);
if (!endpoint?.strictTls) {
	console.error('The guarded database must require verified TLS.');
	process.exit(1);
}
const client = postgres(databaseUrl, {
	max: 1, prepare: false, connect_timeout: 15, idle_timeout: 5,
	onnotice: () => {}, socket: createDatabaseSocketFactory(endpoint),
	ssl: { rejectUnauthorized: true, servername: endpoint.hostname }
} as Parameters<typeof postgres>[1]);
let phase = 'schema inspection';
try {
	const before = await getMigrationStatus(client);
	console.log(JSON.stringify({ phase: 'before', schema: before }));
	if (!before.tableExists) throw new Error('Existing ledger required');
	if (operation === 'apply-topic') {
		phase = 'guarded topic migration';
		const result = await runMigrations(client as unknown as MigrationClient, {
			expectedPending: before.ok ? [] : ['0017_topic_projects']
		});
		console.log(JSON.stringify({ phase: 'migration', ...result }));
	}
	phase = 'schema verification';
	const after = await getMigrationStatus(client);
	const [tables] = await client.unsafe<Array<{ total: number; rls_enabled: number }>>(`
		SELECT count(*)::int AS total, count(*) FILTER (WHERE relrowsecurity)::int AS rls_enabled
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r'`);
	const projects = await client.unsafe<Array<{ name: string; rls: boolean; browser_grants: boolean }>>(`
		SELECT c.relname AS name, c.relrowsecurity AS rls,
			EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
				LEFT JOIN pg_roles r ON r.oid = acl.grantee
				WHERE acl.grantee = 0 OR r.rolname IN ('anon', 'authenticated')) AS browser_grants
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r'
			AND c.relname IN ('projects', 'project_conversations') ORDER BY c.relname`);
	console.log(JSON.stringify({ phase: 'after', schema: after, tables, projects }));
	if (!after.ok || projects.length !== 2 || projects.some(row => !row.rls || row.browser_grants)) {
		process.exitCode = 1;
	}
} catch {
	// Never print driver errors, connection parameters, or the resolved environment.
	console.error(`Local database operation failed during ${phase}; no connection details were printed.`);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 }).catch(() => {});
}
