import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { prepareEvidenceMigration } from './prepare-evidence-migration.mjs';

const contents = 'CREATE TABLE project_documents (id text);';
const digest = createHash('sha256').update(contents).digest('hex');

test('guards the exact target, ledger, application role and every privilege under one transaction', () => {
  const sql = prepareEvidenceMigration(contents, digest);
  assert.ok(sql.indexOf('BEGIN;') < sql.indexOf('pg_advisory_xact_lock'));
  assert.ok(sql.indexOf('SET LOCAL search_path = public;') < sql.indexOf('pg_advisory_xact_lock'));
  assert.ok(sql.indexOf('only the exact 0027 pending set') < sql.indexOf(contents));
  assert.match(sql, /current_database\(\) <> 'newscraft'/);
  assert.match(sql, /0026_rename_agent_runs/);
  assert.match(sql, /unrecorded pre-existing evidence tables/);
  assert.match(sql, /rolbypassrls AND NOT rolsuper/);
  assert.match(sql, /ARRAY\['SELECT', 'INSERT', 'UPDATE', 'DELETE'\]/);
  assert.ok(sql.indexOf('application grants are incomplete') < sql.indexOf('INSERT INTO public.newscraft_schema_migrations'));
  assert.ok(sql.indexOf('INSERT INTO public.newscraft_schema_migrations') < sql.indexOf('COMMIT;'));
});

test('refuses absent, malformed and changed reviewed checksums', () => {
  for (const expected of [undefined, '', 'not-a-digest', 'f'.repeat(64)]) {
    assert.throws(() => prepareEvidenceMigration(contents, expected), /checksum did not match/);
  }
  assert.throws(() => prepareEvidenceMigration(contents + '\n', digest), /checksum did not match/);
});

test('alternate database identity is an internal test-only argument with strict syntax', () => {
  assert.match(prepareEvidenceMigration(contents, digest, 'newscraft_fixture_abcd'), /current_database\(\) <> 'newscraft_fixture_abcd'/);
  assert.throws(() => prepareEvidenceMigration(contents, digest, "unsafe';"), /Invalid reviewed database identity/);
});

test('the CLI requires an exact reviewed digest before emitting any migration SQL', () => {
  const result = spawnSync(process.execPath, ['scripts/prepare-evidence-migration.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Use --expect-sha256/);
});
