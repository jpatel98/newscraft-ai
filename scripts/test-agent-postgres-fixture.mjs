#!/usr/bin/env node
/** Disposable LOCAL Postgres tests. Never accepts or reads an existing DB URL. */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSIONS } from '../src/lib/server/db/migration-contract.ts';
import { prepareEvidenceMigration } from './prepare-evidence-migration.mjs';

if (process.argv.length !== 2) throw new Error('This fixture accepts no database URL or test command.');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use the project Node 24 runtime.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const directory = await mkdtemp(path.join(tmpdir(), 'newscraft-pg-fixture-'));
const data = path.join(directory, 'data');
const socket = path.join(directory, 'socket');
const pgBin = process.env.NEWSCRAFT_FIXTURE_PG_BIN || '/opt/homebrew/bin';
const port = randomInt(20000, 50000);
const database = 'newscraft_fixture_' + randomUUID().replaceAll('-', '');
const databaseUrl = `postgres://fixture@127.0.0.1:${port}/${database}`;
// Do not forward provider keys, existing database URLs, PG* settings or .env files.
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
// Match initdb's --no-locale and avoid macOS postmaster startup depending on
// the caller's locale (including an absent or invalid login-shell LANG).
env.LANG = 'C';
env.LC_ALL = 'C';
env.NODE_ENV = 'test';
env.NEWSCRAFT_TEST_DATABASE_URL = databaseUrl;
env.PGPASSFILE = path.join(directory, 'empty-pgpass');
env.PGSERVICEFILE = path.join(directory, 'empty-pgservice');
let active;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  active?.kill('SIGTERM');
});

function command(binary, args, { inherit = false, seconds = 30, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    active = child;
    let output = '';
    const append = chunk => { output += chunk; if (output.length > 1000000) child.kill('SIGTERM'); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => child.kill('SIGTERM'), seconds * 1000);
    timer.unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (active === child) active = null;
      if (code === 0 || allowFailure) resolve({ code, output });
      else reject(new Error(`${path.basename(binary)} failed (${code}): ${output}`));
    });
  });
}

let initialized = false;
let stopped = true;
try {
  await mkdir(socket, { mode: 0o700 });
  await writeFile(env.PGPASSFILE, '', { mode: 0o600 });
  await writeFile(env.PGSERVICEFILE, '', { mode: 0o600 });
  await command(path.join(pgBin, 'initdb'), ['-D', data, '--username=fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  initialized = true;
  if (interrupted) throw new Error('Fixture interrupted before startup.');
  // Only the new fixture listens; no existing service is restarted or stopped.
  stopped = false;
  await command(path.join(pgBin, 'pg_ctl'), ['-D', data, '-l', path.join(directory, 'postgres.log'), '-w', '-t', '15', 'start', '-o',
    `-h 127.0.0.1 -p ${port} -k ${socket} -c unix_socket_permissions=0700 -c max_connections=50 -c shared_buffers=16MB`]);
  await command(path.join(pgBin, 'createdb'), ['-h', socket, '-p', String(port), '-U', 'fixture', database]);
  const identity = await command(path.join(pgBin, 'psql'), ['-X', '-h', socket, '-p', String(port), '-U', 'fixture', '-d', database, '-Atc',
    "SELECT current_database() || '|' || current_setting('data_directory') || '|' || current_setting('listen_addresses')"]);
  if (identity.output.trim() !== `${database}|${data}|127.0.0.1`) throw new Error('Fixture ownership or loopback binding did not match.');
  const privateEnv = path.join(directory, 'private-env.mjs');
  await writeFile(privateEnv, `export const env = { DATABASE_URL: process.env.NEWSCRAFT_TEST_DATABASE_URL, APP_PASSWORD_HASH: '',
    APP_SESSION_SECRET: Buffer.from('public-synthetic-test-fixture-session-signing-value').toString('base64'),
    NEWSCRAFT_AUTH_PROVIDER: 'postgres', NEWSCRAFT_STORAGE_PROVIDER: 'vps', NEWSCRAFT_ARTIFACT_LOCAL_STORAGE: '1',
    NEWSCRAFT_ARTIFACT_STORAGE_DIR: ${JSON.stringify(path.join(directory, 'artifacts'))} };\n`, { mode: 0o600 });
  const config = path.join(directory, 'vitest.config.mjs');
  const appEnvironment = path.join(directory, 'app-environment.mjs');
  await writeFile(appEnvironment, "export const dev = true; export const browser = false; export const building = false; export const version = 'fixture';\n", { mode: 0o600 });
  await writeFile(config, `export default ${JSON.stringify({
    root, envDir: directory,
    resolve: { alias: { '$env/dynamic/private': privateEnv, '$app/environment': appEnvironment, '$lib': path.join(root, 'src/lib') } },
    test: { include: ['src/lib/server/db/*.integration.test.ts', 'src/lib/server/db/migration-runner.test.ts'], environment: 'node',
      fileParallelism: false, maxWorkers: 1, testTimeout: 45000, hookTimeout: 45000 }
  }, null, 2)};\n`, { mode: 0o600 });
  console.log('Running against a new, disposable loopback Postgres fixture. No Supabase or production connection is used.');
  if (interrupted) throw new Error('Fixture interrupted before tests.');
  await command(process.execPath, [path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run', '--config', config], { inherit: true, seconds: 180 });
  const counts = await command(path.join(pgBin, 'psql'), ['-X', '-h', socket, '-p', String(port), '-U', 'fixture', '-d', database, '-Atc',
    "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"]);
  console.log(`Fixture verification completed; public tables: ${counts.output.trim()}.`);
  const migrationDatabase = database + '_migration';
  await command(path.join(pgBin, 'createdb'), ['-h', socket, '-p', String(port), '-U', 'fixture', migrationDatabase]);
  const psqlArguments = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', String(port), '-U', 'fixture', '-d', migrationDatabase];
  const baseline = ["BEGIN;", "DO $roles$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'newscraft_app') THEN CREATE ROLE newscraft_app LOGIN BYPASSRLS; END IF; END $roles$;",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO newscraft_app;",
    "CREATE TABLE newscraft_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"];
  for (const version of MIGRATION_VERSIONS.filter(item => item !== '0027_project_evidence')) {
    baseline.push(await readFile(path.join(root, 'drizzle', version + '.sql'), 'utf8'));
    baseline.push("INSERT INTO newscraft_schema_migrations (version) VALUES ('" + version + "');");
  }
  baseline.push('COMMIT;');
  const baselineFile = path.join(directory, 'baseline.sql');
  await writeFile(baselineFile, baseline.join('\n'), { mode: 0o600 });
  await command(path.join(pgBin, 'psql'), [...psqlArguments, '-f', baselineFile]);
  const migrationContents = await readFile(path.join(root, 'drizzle/0027_project_evidence.sql'), 'utf8');
  const migrationDigest = createHash('sha256').update(migrationContents).digest('hex');
  const guardedFile = path.join(directory, 'guarded-evidence.sql');
  await writeFile(guardedFile, prepareEvidenceMigration(migrationContents, migrationDigest, migrationDatabase), { mode: 0o600 });
  const evidenceRelations = ['project_documents', 'project_document_pages', 'project_datasets', 'project_dataset_rows', 'project_analysis_runs', 'project_findings'];
  const shadowFile = path.join(directory, 'shadow-schema.sql');
  await writeFile(shadowFile, ['CREATE SCHEMA migration_shadow;',
    ...[...evidenceRelations, 'newscraft_schema_migrations'].map(relation => `CREATE TABLE migration_shadow.${relation} (sentinel text NOT NULL); INSERT INTO migration_shadow.${relation} VALUES ('synthetic-shadow-row');`)].join('\n'), { mode: 0o600 });
  await command(path.join(pgBin, 'psql'), [...psqlArguments, '-f', shadowFile]);
  const shadowArguments = [...psqlArguments, '-c', 'SET search_path = migration_shadow, public'];
  await command(path.join(pgBin, 'psql'), [...shadowArguments, '-f', guardedFile]);
  const reapplied = await command(path.join(pgBin, 'psql'), [...psqlArguments, '-f', guardedFile], { allowFailure: true });
  if (reapplied.code === 0) throw new Error('Guarded evidence migration unexpectedly allowed reapplication.');
  const rollbackFile = path.join(root, 'drizzle/rollback/0027_project_evidence.down.sql');
  await command(path.join(pgBin, 'psql'), [...shadowArguments, '-f', rollbackFile]);
  for (const relation of [...evidenceRelations, 'newscraft_schema_migrations']) {
    const retained = await command(path.join(pgBin, 'psql'), [...psqlArguments, '-Atc', `SELECT count(*) FROM migration_shadow.${relation} WHERE sentinel = 'synthetic-shadow-row'`]);
    assert.equal(retained.output.trim(), '1');
  }
  const rolledBack = await command(path.join(pgBin, 'psql'), [...psqlArguments, '-Atc', "SELECT count(*) FROM public.newscraft_schema_migrations WHERE version = '0027_project_evidence'"]);
  assert.equal(rolledBack.output.trim(), '0');
  await command(path.join(pgBin, 'psql'), [...shadowArguments, '-f', guardedFile]);
  const retainedDataFile = path.join(directory, 'retained-data.sql');
  await writeFile(retainedDataFile, `INSERT INTO public.accounts (id, email, created_at, updated_at) VALUES ('migration-fixture', 'migration-fixture@example.invalid', 1, 1);
INSERT INTO public.projects (id, account_id, name, created_at, updated_at) VALUES ('migration-project', 'migration-fixture', 'Synthetic retained evidence', 1, 1);
INSERT INTO public.project_analysis_runs (id, account_id, project_id, status, trigger, analyzer_version, input_documents, started_at) VALUES ('migration-run', 'migration-fixture', 'migration-project', 'running', 'manual', 'fixture', '[]', 1);\n`, { mode: 0o600 });
  await command(path.join(pgBin, 'psql'), [...psqlArguments, '-f', retainedDataFile]);
  const refusedRollback = await command(path.join(pgBin, 'psql'), [...shadowArguments, '-f', rollbackFile], { allowFailure: true });
  assert.notEqual(refusedRollback.code, 0);
  assert.match(refusedRollback.output, /Refusing evidence rollback with retained data/);
  const retainedState = await command(path.join(pgBin, 'psql'), [...psqlArguments, '-Atc', "SELECT (SELECT count(*) FROM public.newscraft_schema_migrations WHERE version = '0027_project_evidence') || '|' || (SELECT count(*) FROM public.project_analysis_runs WHERE id = 'migration-run')"]);
  assert.equal(retainedState.output.trim(), '1|1');
  console.log('Guarded evidence migration, refused reapplication, shadow-schema isolation, empty rollback/reapply and populated rollback refusal passed on a second disposable database.');
  if (process.env.NEWSCRAFT_FIXTURE_EVIDENCE_BROWSER === '1') {
    const authority = path.join(directory, 'browser-authority.json');
    const nonce = randomUUID();
    await writeFile(authority, JSON.stringify({ nonce, database, data }), { mode: 0o600 });
    env.NEWSCRAFT_EVIDENCE_FIXTURE_AUTHORITY = authority;
    env.NEWSCRAFT_EVIDENCE_FIXTURE_NONCE = nonce;
    await command(process.execPath, [path.join(root, 'scripts/test-evidence-browser.mjs')], { inherit: true, seconds: 240 });
  }
} catch (error) {
  console.error(error.message);
  try { console.error((await readFile(path.join(directory, 'postgres.log'), 'utf8')).slice(-4000)); } catch {}
  process.exitCode = 1;
} finally {
  if (initialized && !stopped) {
    const status = await command(path.join(pgBin, 'pg_ctl'), ['-D', data, 'status'], { allowFailure: true });
    if (status.code === 0) {
      const result = await command(path.join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'], { allowFailure: true });
      stopped = result.code === 0;
    } else stopped = status.code === 3;
  }
  if (stopped) {
    await rm(directory, { recursive: true, force: true });
    console.log('Disposable fixture stopped and its own temporary directory removed.');
  } else {
    process.exitCode = 1;
    console.error(`Fixture shutdown was not confirmed; retained its private directory: ${directory}`);
  }
}
