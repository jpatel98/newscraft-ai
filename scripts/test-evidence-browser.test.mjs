import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function run(environment = {}) {
  return spawnSync(process.execPath, ['scripts/test-evidence-browser.mjs'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, TMPDIR: tmpdir(), ...environment }
  });
}

test('browser smoke refuses missing fixture authority before opening services', () => {
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Run through NEWSCRAFT_FIXTURE_EVIDENCE_BROWSER/);
});

test('browser smoke rejects arbitrary authority files before reading their contents', () => {
  const result = run({
    NEWSCRAFT_EVIDENCE_FIXTURE_AUTHORITY: '/private/tmp/unrelated-config',
    NEWSCRAFT_EVIDENCE_FIXTURE_NONCE: 'synthetic',
    NEWSCRAFT_TEST_DATABASE_URL: 'postgres://fixture@127.0.0.1:1/newscraft_fixture_abcd'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authority path is invalid/);
});

test('malformed authority never prints its contents or connection input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'newscraft-pg-fixture-'));
  const authority = path.join(directory, 'browser-authority.json');
  try {
    await writeFile(authority, 'SYNTHETIC_PRIVATE_CANARY', { mode: 0o600 });
    const result = run({
      NEWSCRAFT_EVIDENCE_FIXTURE_AUTHORITY: authority,
      NEWSCRAFT_EVIDENCE_FIXTURE_NONCE: 'synthetic',
      NEWSCRAFT_TEST_DATABASE_URL: 'SYNTHETIC_CONNECTION_CANARY'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /authority is malformed/);
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_CANARY|SYNTHETIC_CONNECTION_CANARY/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
