#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, lstat, realpath, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import postgres from 'postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
if (process.argv.length !== 2) throw new Error('This fixture takes no arguments.');
const authorityPath = process.env.NEWSCRAFT_EVIDENCE_FIXTURE_AUTHORITY;
const fixtureUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL;
if (!authorityPath || !fixtureUrl || !process.env.NEWSCRAFT_EVIDENCE_FIXTURE_NONCE) {
  throw new Error('Run through NEWSCRAFT_FIXTURE_EVIDENCE_BROWSER=1 node scripts/test-agent-postgres-fixture.mjs.');
}
const authorityDirectory = path.dirname(path.resolve(authorityPath));
if (path.basename(authorityPath) !== 'browser-authority.json' ||
    !/^newscraft-pg-fixture-[A-Za-z0-9]+$/.test(path.basename(authorityDirectory)) ||
    path.dirname(authorityDirectory) !== await realpath(tmpdir())) {
  throw new Error('Disposable fixture authority path is invalid.');
}
for (const [target, directory] of [[authorityDirectory, true], [authorityPath, false]]) {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
      (metadata.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('Disposable fixture authority must be private and owned.');
  }
}
let authority;
let endpoint;
try {
  authority = JSON.parse(await readFile(authorityPath, 'utf8'));
  endpoint = new URL(fixtureUrl);
} catch {
  throw new Error('Disposable fixture authority is malformed.');
}
if (authority.nonce !== process.env.NEWSCRAFT_EVIDENCE_FIXTURE_NONCE ||
    endpoint.hostname !== '127.0.0.1' || endpoint.username !== 'fixture' ||
    endpoint.password || !/^newscraft_fixture_[a-f0-9]+$/.test(authority.database) ||
    endpoint.pathname !== '/' + authority.database ||
    path.dirname(authorityPath) !== path.dirname(authority.data)) {
  throw new Error('Disposable fixture authority did not match.');
}
const database = postgres(fixtureUrl, { max: 1, prepare: false, onnotice: () => {} });
try {
  const [identity] = await database`SELECT current_database() AS database, current_setting('data_directory') AS directory`;
  assert.equal(identity.database, authority.database);
  assert.equal(identity.directory, authority.data);
} finally {
  await database.end({ timeout: 2 });
}
const directory = await mkdtemp(path.join(path.dirname(authorityPath), 'evidence-browser-'));
const checks = [];
const children = [];
let browser;
function recordCheck(check) {
  checks.push(check);
  console.log(JSON.stringify({ evidenceBrowserCheck: check }));
}
function interrupt() {
  process.exitCode = 1;
  for (const child of children) child.kill('SIGTERM');
  void browser?.close().catch(() => {});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const storageKey = 'synthetic-evidence-browser-storage-key';
const seedSecret = 'synthetic-evidence-browser-seed-secret';

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'ignore' });
  children.push(child);
  child.once('error', () => {});
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function waitReady(url, child) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Synthetic service exited during startup.');
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Synthetic service readiness timed out.');
}

function pdf(text) {
  const stream = 'BT /F1 12 Tf 40 720 Td (' + text.replace(/[()\\]/g, '\\$&') + ') Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream'
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 6\n0000000000 65535 f \n';
  body += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  body += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(body);
}

async function signIn(page, baseUrl, password) {
  const response = await page.request.post(baseUrl + '/api/e2e/seed', { data: { secret: seedSecret, password } });
  assert.equal(response.status(), 200);
  const account = await response.json();
  await page.goto(baseUrl + '/login');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused({ timeout: 20000 });
  await page.getByLabel('Email', { exact: true }).fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(baseUrl + '/', { timeout: 30000 });
  await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
}

async function upload(page, projectUrl, file) {
  await page.goto(projectUrl);
  await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
  await page.locator('.evidence input[type=file]').setInputFiles(file);
  const row = page.locator('.evidence-row').filter({ has: page.locator('strong', { hasText: file.name }) }).last();
  await expect(row).toContainText('Ready', { timeout: 30000 });
  return row;
}

async function restrictNetwork(context, allowedOrigins) {
  await context.route('**/*', route => allowedOrigins.includes(new URL(route.request().url()).origin)
    ? route.continue() : route.abort());
}

try {
  const appPort = await freePort();
  const storagePort = await freePort();
  const appUrl = 'http://127.0.0.1:' + appPort;
  const storageUrl = 'http://127.0.0.1:' + storagePort;
  const storage = start(process.execPath, [path.join(root, 'infra/newscraft-storage/server.mjs')], {
    ...environment,
    PORT: String(storagePort),
    NEWSCRAFT_STORAGE_HOST: '127.0.0.1',
    NEWSCRAFT_STORAGE_ROOT: path.join(directory, 'storage'),
    NEWSCRAFT_STORAGE_API_KEY: storageKey,
    NEWSCRAFT_STORAGE_SIGNING_KEY: 'synthetic-evidence-browser-signing-key-over-32-bytes',
    NEWSCRAFT_STORAGE_PUBLIC_URL: storageUrl,
    NEWSCRAFT_STORAGE_CORS_ORIGIN: appUrl
  });
  await waitReady(storageUrl + '/health', storage);
  const dependencyRoot = await realpath(path.join(root, 'node_modules/.pnpm'));
  const viteConfig = path.join(directory, 'vite.config.mjs');
  await writeFile(viteConfig, `import base from ${JSON.stringify(pathToFileURL(path.join(root, 'vite.config.ts')).href)};
export default { ...base, root: ${JSON.stringify(root)}, server: { ...base.server, fs: { strict: true, allow: ${JSON.stringify([root, dependencyRoot])} } } };\n`, { mode: 0o600 });
  const app = start(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), '--config', viteConfig, '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
    ...environment,
    DATABASE_URL: fixtureUrl,
    NEWSCRAFT_TEST_DATABASE_URL: '',
    APP_SESSION_SECRET: Buffer.from('synthetic-evidence-browser-session-signing-value').toString('base64'),
    NEWSCRAFT_AUTH_PROVIDER: 'postgres',
    NEWSCRAFT_AGENT_URL: 'http://127.0.0.1:9',
    NEWSCRAFT_AGENT_API_TOKEN: 'synthetic-disabled-worker-token',
    NEWSCRAFT_AGENT_HEALTH_ONLY: '1',
    NEWSCRAFT_STORAGE_PROVIDER: 'vps',
    NEWSCRAFT_STORAGE_BASE_URL: storageUrl,
    NEWSCRAFT_STORAGE_API_KEY: storageKey,
    NEWSCRAFT_DOCUMENT_STORAGE_BUCKET: 'newsroom-documents',
    NEWSCRAFT_EVIDENCE_CSV_BUCKET: 'newsroom-artifacts',
    E2E_SECRET: seedSecret
  });
  await waitReady(appUrl + '/login', app);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const browserErrors = [];
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await restrictNetwork(context, [appUrl, storageUrl]);
    const page = await context.newPage();
    page.on('pageerror', error => {
      browserErrors.push(error.name);
      console.log(JSON.stringify({ browserError: error.name, message: error.message.replace(/\/v1\/(?:upload|download)\/[^\s]+/g, '/v1/[redacted]').slice(0, 500) }));
    });
    page.on('requestfailed', request => {
      const requestUrl = new URL(request.url());
      console.log(JSON.stringify({ failedRequest: requestUrl.pathname.replace(/\/v1\/(?:upload|download)\/.*/, '/v1/[redacted]'), reason: request.failure()?.errorText }));
    });
    page.on('dialog', dialog => dialog.accept());
    await signIn(page, appUrl, 'synthetic-evidence-' + name + '-' + randomUUID());
    recordCheck(name + ': signed-in');
    const projectResponse = await page.request.post(appUrl + '/api/projects', { data: { name: 'Evidence smoke ' + name } });
    assert.equal(projectResponse.status(), 201);
    const project = await projectResponse.json();
    const projectUrl = appUrl + '/projects/' + project.id;
    const csv = { name: 'vendors.csv', mimeType: 'text/csv', buffer: Buffer.from('vendor_id,address,amount\nV-1001,10 King St,100\nV-1002,20 Queen St,200\nV-1001,10 King St,300\n') };
    const csvRow = await upload(page, projectUrl, csv);
    recordCheck(name + ': CSV upload and seal');
    await csvRow.getByRole('button', { name: 'Inspect', exact: true }).click();
    await expect(page.locator('.evidence-inspector')).toContainText('V-1001');
    await page.locator('.evidence-inspector').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.evidence-inspector')).toHaveCount(0);
    recordCheck(name + ': CSV inspector and close');
    await upload(page, projectUrl, { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf('Synthetic audit: V-1001 and V-1002 are listed.') });
    recordCheck(name + ': PDF upload and extraction');
    const documentsResponse = await page.request.get(appUrl + '/api/projects/' + project.id + '/evidence');
    const documents = (await documentsResponse.json()).documents;
    const csvDocument = documents.find(document => document.name === 'vendors.csv');
    assert.ok(csvDocument?.sha256);
    const download = await page.request.get(appUrl + '/api/projects/' + project.id + '/evidence/' + csvDocument.id + '/download');
    assert.equal(download.status(), 200);
    assert.deepEqual(await download.body(), csv.buffer);
    recordCheck(name + ': exact original download');
    await page.getByRole('button', { name: 'Analyze evidence', exact: true }).click();
    await expect(page.locator('.finding-card').first()).toBeVisible({ timeout: 30000 });
    const lead = page.locator('.finding-card').filter({ has: page.getByRole('button', { name: 'Save', exact: true }) }).first();
    await lead.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.finding-saved').first()).toBeVisible();
    recordCheck(name + ': deterministic analysis and save');
    const deleteProject = await page.request.delete(appUrl + '/api/projects/' + project.id);
    assert.equal(deleteProject.status(), 409);
    recordCheck(name + ': nonempty folder protected');
    const otherContext = await browser.newContext();
    await restrictNetwork(otherContext, [appUrl, storageUrl]);
    const other = await otherContext.newPage();
    await signIn(other, appUrl, 'synthetic-other-' + name + '-' + randomUUID());
    const denied = await other.request.get(appUrl + '/api/projects/' + project.id + '/evidence');
    assert.equal(denied.status(), 404);
    await otherContext.close();
    recordCheck(name + ': foreign account denied');
    await page.goto(projectUrl);
    await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
    const removalResponse = page.waitForResponse(response => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === '/api/projects/' + project.id + '/evidence/' + csvDocument.id);
    await page.locator('.evidence-row').filter({ has: page.locator('strong', { hasText: 'vendors.csv' }) }).last().getByRole('button', { name: 'Remove', exact: true }).click();
    const removed = await removalResponse;
    assert.equal(removed.status(), 200);
    await expect(page.locator('.evidence-row').filter({ has: page.locator('strong', { hasText: 'vendors.csv' }) })).toHaveCount(0);
    await expect.poll(async () => (await (await page.request.get(appUrl + '/api/projects/' + project.id + '/evidence')).json()).documents.length).toBe(1);
    const findings = (await (await page.request.get(appUrl + '/api/projects/' + project.id + '/findings')).json()).findings;
    assert.ok(findings.some(finding => finding.evidence.some(source => source.documentId === csvDocument.id && source.withdrawn)));
    assert.ok(!findings.some(finding => finding.evidence.some(source => source.documentId === csvDocument.id && source.rows?.length)));
    recordCheck(name + ': deleted excerpts withdrawn');
    await page.reload();
    await expect(page.locator('.shell')).toHaveAttribute('data-ready', 'true', { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    recordCheck(name + ': no horizontal overflow');
    await context.close();
  }
  assert.deepEqual(browserErrors, []);
  recordCheck('no browser page errors');
  console.log(JSON.stringify({ evidenceBrowser: 'passed', checksPassed: checks.length, browsers: ['desktop', 'mobile'], network: 'loopback-only', providerCalls: 0 }));
} finally {
  for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt);
  await browser?.close();
  for (const child of children.reverse()) await stop(child);
  await rm(directory, { recursive: true, force: true });
}
