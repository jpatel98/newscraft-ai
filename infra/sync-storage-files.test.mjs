import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, afterEach } from 'node:test';

const script = join(process.cwd(), 'infra', 'sync-storage-files.mjs');
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function run(source, destination, ...extra) {
  return spawnSync(process.execPath, [script, '--source', source, '--destination', destination, ...extra], {
    encoding: 'utf8'
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'newscraft-sync-'));
  temporaryRoots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  await mkdir(join(source, 'documents'), { recursive: true });
  await mkdir(join(source, '.tokens'), { recursive: true });
  await writeFile(join(source, 'documents', 'brief.pdf'), 'source-content');
  await writeFile(join(source, '.tokens', 'one-use-token'), 'must-not-copy');
  await mkdir(destination);
  return { source, destination };
}

test('plans and applies missing regular files while skipping token state', async () => {
  const { source, destination } = await fixture();
  const planResult = run(source, destination);
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.mode, 'plan');
  assert.deepEqual(plan.counts, {
    sourceFiles: 1,
    destinationFiles: 0,
    missing: 1,
    identical: 0,
    conflicts: 0,
    destinationOnly: 0,
    skippedSource: 1,
    skippedDestination: 0
  });

  const applyResult = run(source, destination, '--apply', '--ack', 'NEWSCRAFT_FINAL_SYNC_ACK');
  assert.equal(applyResult.status, 0, applyResult.stderr);
  const applied = JSON.parse(applyResult.stdout);
  assert.equal(applied.mode, 'apply');
  assert.deepEqual(applied.copied.map(({ path }) => path), ['documents/brief.pdf']);
  assert.equal(await readFile(join(destination, 'documents', 'brief.pdf'), 'utf8'), 'source-content');
});

test('reports identical and destination-only files without deleting either side', async () => {
  const { source, destination } = await fixture();
  const applyResult = run(source, destination, '--apply', '--ack', 'NEWSCRAFT_FINAL_SYNC_ACK');
  assert.equal(applyResult.status, 0, applyResult.stderr);
  await writeFile(join(destination, 'keep.txt'), 'destination-only');
  const result = run(source, destination);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.counts.identical, 1);
  assert.equal(plan.counts.destinationOnly, 1);
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'destination-only');
});

test('supports reverse reconciliation for rollback writes', async () => {
  const { source, destination } = await fixture();
  assert.equal(run(source, destination, '--apply', '--ack', 'NEWSCRAFT_FINAL_SYNC_ACK').status, 0);
  await writeFile(join(destination, 'documents', 'rollback-note.txt'), 'written while on VPS');
  const result = run(source, destination, '--direction', 'destination-to-source', '--apply', '--ack', 'NEWSCRAFT_FINAL_SYNC_ACK');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.direction, 'destination-to-source');
  assert.deepEqual(plan.copied.map(({ path }) => path), ['documents/rollback-note.txt']);
  assert.equal(await readFile(join(source, 'documents', 'rollback-note.txt'), 'utf8'), 'written while on VPS');
});

test('refuses conflicts and never overwrites the destination', async () => {
  const { source, destination } = await fixture();
  assert.equal(run(source, destination, '--apply', '--ack', 'NEWSCRAFT_FINAL_SYNC_ACK').status, 0);
  await writeFile(join(destination, 'documents', 'brief.pdf'), 'operator-change');
  const planResult = run(source, destination);
  assert.equal(planResult.status, 0, planResult.stderr);
  assert.equal(JSON.parse(planResult.stdout).counts.conflicts, 1);
  const applyResult = run(source, destination, '--apply', '--ack', 'NEWSCRAFT_FINAL_SYNC_ACK');
  assert.notEqual(applyResult.status, 0);
  assert.match(applyResult.stderr, /conflicting destination file/);
  assert.equal(await readFile(join(destination, 'documents', 'brief.pdf'), 'utf8'), 'operator-change');
});

test('requires an explicit acknowledgement for apply', async () => {
  const { source, destination } = await fixture();
  const result = run(source, destination, '--apply');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --ack NEWSCRAFT_FINAL_SYNC_ACK/);
});
