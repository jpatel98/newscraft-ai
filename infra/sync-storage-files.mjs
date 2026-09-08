#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, lstat, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const ACK = 'NEWSCRAFT_FINAL_SYNC_ACK';
const DIRECTIONS = new Set(['source-to-destination', 'destination-to-source']);

function usage() {
  return `Usage: sync-storage-files.mjs --source DIR --destination DIR [options]

Options:
  --direction source-to-destination|destination-to-source (default: source-to-destination)
  --apply                         copy missing files; default is a read-only plan
  --ack ${ACK}              required with --apply
  --help

The tool is additive: it never deletes destination-only files and never
overwrites a conflicting destination file. The reverse direction is intended
for an explicit rollback reconciliation.
`;
}

function parseArgs(argv) {
  const args = { apply: false, direction: 'source-to-destination' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--plan') continue;
    if (arg === '--source' || arg === '--destination' || arg === '--direction' || arg === '--ack') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--source') args.source = value;
      if (arg === '--destination') args.destination = value;
      if (arg === '--direction') args.direction = value;
      if (arg === '--ack') args.ack = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.source || !args.destination) throw new Error('--source and --destination are required');
  if (!DIRECTIONS.has(args.direction)) throw new Error(`invalid --direction: ${args.direction}`);
  if (args.apply && args.ack !== ACK) throw new Error(`--apply requires --ack ${ACK}`);
  return args;
}

function rootIsBroad(path) {
  const normalized = resolve(path);
  const root = resolve(normalized, sep);
  if (normalized === root) return true;
  const forbidden = new Set([
    resolve(process.cwd()),
    resolve(process.env.HOME || '/nonexistent'),
    resolve('/private'),
    resolve('/Users'),
    resolve('/home'),
    resolve('/var'),
    resolve('/tmp')
  ]);
  return forbidden.has(normalized);
}

function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function validateRoots(sourceInput, destinationInput) {
  const sourceRoot = resolve(sourceInput);
  const destinationRoot = resolve(destinationInput);
  if (sourceRoot === destinationRoot) throw new Error('source and destination must be different directories');
  if (rootIsBroad(sourceRoot) || rootIsBroad(destinationRoot)) throw new Error('source and destination must be specific, non-broad directories');
  if (pathContains(sourceRoot, destinationRoot) || pathContains(destinationRoot, sourceRoot)) {
    throw new Error('source and destination cannot contain one another');
  }
  const sourceInfo = await lstat(sourceRoot).catch(() => null);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`source directory is missing or unsafe: ${sourceRoot}`);
  const destinationInfo = await lstat(destinationRoot).catch(() => null);
  if (destinationInfo && (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink())) {
    throw new Error(`destination directory is missing or unsafe: ${destinationRoot}`);
  }
  return { sourceRoot, destinationRoot };
}

async function hashFile(path) {
  const contents = createReadStream(path);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of contents) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function manifest(root) {
  const files = {};
  const skipped = [];
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name === '.tokens' || rel.split('/').includes('.tokens')) {
        skipped.push(rel);
        continue;
      }
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, rel);
      } else if (entry.isFile()) {
        const digest = await hashFile(absolute);
        files[rel] = digest;
      } else {
        skipped.push(rel);
      }
    }
  }
  await visit(root);
  return { files, skipped };
}

function buildPlan(sourceManifest, destinationManifest, roots, direction) {
  const missing = [];
  const identical = [];
  const conflicts = [];
  const destinationOnly = [];
  for (const [path, source] of Object.entries(sourceManifest.files)) {
    const destination = destinationManifest.files[path];
    if (!destination) missing.push({ path, ...source });
    else if (source.bytes === destination.bytes && source.sha256 === destination.sha256) identical.push({ path, ...source });
    else conflicts.push({ path, source, destination });
  }
  for (const path of Object.keys(destinationManifest.files)) {
    if (!sourceManifest.files[path]) destinationOnly.push({ path, ...destinationManifest.files[path] });
  }
  return {
    direction,
    sourceRoot: roots.sourceRoot,
    destinationRoot: roots.destinationRoot,
    counts: {
      sourceFiles: Object.keys(sourceManifest.files).length,
      destinationFiles: Object.keys(destinationManifest.files).length,
      missing: missing.length,
      identical: identical.length,
      conflicts: conflicts.length,
      destinationOnly: destinationOnly.length,
      skippedSource: sourceManifest.skipped.length,
      skippedDestination: destinationManifest.skipped.length
    },
    missing,
    identical,
    conflicts,
    destinationOnly,
    sourceManifest,
    destinationManifest
  };
}

async function applyPlan(plan) {
  if (plan.conflicts.length > 0) {
    const error = new Error(`refusing to apply: ${plan.conflicts.length} conflicting destination file(s)`);
    error.code = 'SYNC_CONFLICT';
    throw error;
  }
  const copied = [];
  for (const item of plan.missing) {
    const sourcePath = resolve(plan.sourceRoot, ...item.path.split('/'));
    const destinationPath = resolve(plan.destinationRoot, ...item.path.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    // COPYFILE_EXCL makes a concurrent destination write fail closed. Never
    // replace a file that was not present during the read-only plan.
    await copyFile(sourcePath, destinationPath, 1);
    await chmod(destinationPath, 0o600);
    const after = await hashFile(destinationPath);
    if (after.bytes !== item.bytes || after.sha256 !== item.sha256) {
      throw new Error(`copied file failed verification: ${item.path}`);
    }
    copied.push({ path: item.path, ...after });
  }
  return copied;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = await validateRoots(args.source, args.destination);
  const actualSource = args.direction === 'source-to-destination' ? roots.sourceRoot : roots.destinationRoot;
  const actualDestination = args.direction === 'source-to-destination' ? roots.destinationRoot : roots.sourceRoot;
  const [sourceManifest, destinationManifest] = await Promise.all([
    manifest(actualSource),
    lstat(actualDestination).then(() => manifest(actualDestination), () => ({ files: {}, skipped: [] }))
  ]);
  const plan = buildPlan(sourceManifest, destinationManifest, { sourceRoot: actualSource, destinationRoot: actualDestination }, args.direction);
  if (args.apply) plan.copied = await applyPlan(plan);
  else plan.copied = [];
  plan.mode = args.apply ? 'apply' : 'plan';
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.code === 'SYNC_CONFLICT' ? 3 : 2;
});
