#!/usr/bin/env node

/*
 * JIG-184 is deliberately an offline recovery matrix.  It exercises only
 * repository-owned contracts and a synthetic tenant backup in private
 * temporary directories.  It never connects to Postgres, Supabase, Hermes,
 * a VPS, Docker, a provider, or a real service process.
 */

import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import {
	chmod,
	open,
	lstat,
	readFile,
	readdir,
	mkdtemp,
	mkdir,
	rm,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const JIG184_TICKET = 'JIG-184';
export const JIG184_EVIDENCE_SCHEMA_VERSION = 1;
export const JIG184_BASE_SHA = 'b104db0b7352ed97201d838ccaa656face51081e';
export const JIG184_ALLOWED_BRANCHES = Object.freeze(['codex/jig-184-recovery', 'main']);
export const HERMES_REVIEWED_COMMIT = '5370d535ab926da41abe3ba4d9d975f1f94875d5';
export const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const SYNTHETIC_SCOPE = 'synthetic-tenant-a';
export const REQUIRED_GATE_IDS = Object.freeze([
	'checkout_identity',
	'backup_scope_inventory',
	'synthetic_tenant_restore',
	'hermes_offline_repository_checks',
	'isolated_postgres_snapshot_restore',
	'pinned_hermes_rebuild_start_readiness',
	'host_loss_recovery_time'
]);

export const LOCAL_RELEASE_LIMITATIONS = Object.freeze([
	'Only repository-static checks and disposable synthetic local files were exercised.',
	'Postgres snapshot restore, current backup state, VPS rebuild, private settings, service readiness, and host-loss RTO are blocked.',
	'No production data, external service, provider, database, real restart, or live deployment evidence is represented.',
	'Hydra is outside the NewsCraft backup, restore, rebuild, rollback, and test boundary.'
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ARTIFACT_RELATIVE_ROOT = '.tmp/jig-184';
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_SYNTHETIC_SCOPE_RE = /^synthetic-tenant-[a-z]$/;
const SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const ALLOWED_GATE_STATES = new Set(['PASS', 'FAIL', 'BLOCKED']);
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SENSITIVE_VALUE_RE = /(?:https?:\/\/|postgres(?:ql)?:\/\/|-----begin|(?:api[_-]?key|password|secret|token|authorization|cookie)\s*[:=])/i;

const RELEASE_RECORD_KEYS = new Set([
	'schema_version',
	'ticket',
	'recorded_at',
	'checkout',
	'candidate',
	'inventory',
	'synthetic_restore',
	'hermes_offline_checks',
	'required_gate_ids',
	'gates',
	'release_decision',
	'release_exit_code',
	'limitations'
]);
const RELEASE_CHECKOUT_KEYS = new Set([
	'branch',
	'source_sha',
	'base_sha',
	'clean',
	'base_present',
	'commit_present',
	'base_is_ancestor'
]);
const RELEASE_CANDIDATE_KEYS = new Set(['source_sha', 'base_sha']);
const RELEASE_INVENTORY_KEYS = new Set([
	'state',
	'repository_reference_count',
	'postgres_relation_groups',
	'hermes_state_areas',
	'live_backup_facts',
	'live_host_facts',
	'hydra_boundary'
]);
const RELEASE_SYNTHETIC_KEYS = new Set([
	'state',
	'restored_file_count',
	'selected_scope_count',
	'excluded_scope_count',
	'private_modes',
	'manifest_integrity',
	'cross_scope_content',
	'duration_ms',
	'backup_file_count'
]);
const RELEASE_GATE_BASE_KEYS = new Set(['id', 'state', 'scope', 'evidence_id']);
const RELEASE_SYNTHETIC_GATE_EVIDENCE_KEYS = new Set([
	'restored_file_count',
	'selected_scope_count',
	'excluded_scope_count',
	'private_modes',
	'manifest_integrity',
	'cross_scope_content',
	'duration_ms'
]);
const RELEASE_HERMES_GATE_EVIDENCE_KEYS = new Set([
	'source_commit',
	'lock_digest',
	'installer_checked',
	'deployment_references_checked'
]);
const CHECKOUT_IDENTITY_KEYS = Object.freeze([
	'branch',
	'source_sha',
	'base_sha',
	'clean',
	'base_present',
	'commit_present',
	'base_is_ancestor'
]);
const RELEASE_GATE_DEFINITIONS = Object.freeze({
	checkout_identity: { scope: 'local-checkout', failure: 'checkout_identity_invalid' },
	backup_scope_inventory: { scope: 'repository-static', failure: 'repository_inventory_invalid' },
	synthetic_tenant_restore: { scope: 'disposable-local', failure: 'synthetic_restore_failed' },
	hermes_offline_repository_checks: { scope: 'repository-static', failure: 'hermes_offline_checks_failed' },
	isolated_postgres_snapshot_restore: {
		scope: 'external-database-authority',
		failure: 'isolated_postgres_restore_requires_separately_authorized_test_database_evidence'
	},
	pinned_hermes_rebuild_start_readiness: {
		scope: 'external-vps-authority',
		failure: 'pinned_hermes_rebuild_and_readiness_requires_separately_authorized_vps_private_configuration_and_service_evidence'
	},
	host_loss_recovery_time: {
		scope: 'external-host-authority',
		failure: 'host_loss_rto_requires_separately_authorized_host_loss_measurement'
	}
});

const POSTGRES_EVIDENCE_KEYS = new Set([
	'schema_version',
	'ticket',
	'candidate_sha',
	'source_sha',
	'captured_at',
	'execution',
	'scope',
	'test_identity',
	'loopback',
	'isolated',
	'test_data_only',
	'schema',
	'rows',
	'isolation',
	'state'
]);
const POSTGRES_SCHEMA_KEYS = new Set(['migration_revision_count', 'schema_digest']);
const POSTGRES_ROWS_KEYS = new Set(['table_count', 'row_count', 'aggregate_digest']);
const POSTGRES_ISOLATION_KEYS = new Set(['selected_scope_count', 'foreign_scope_count']);

const TENANT_MANIFEST_KEYS = new Set([
	'schema_version',
	'ticket',
	'candidate_sha',
	'source_sha',
	'captured_at',
	'scope',
	'files',
	'manifest_sha256'
]);
const TENANT_FILE_KEYS = new Set(['relative_path', 'kind', 'sha256', 'mode']);

const HERMES_EVIDENCE_KEYS = new Set([
	'schema_version',
	'ticket',
	'candidate_sha',
	'source_sha',
	'captured_at',
	'execution',
	'source_commit',
	'lock_digest',
	'installer_reference',
	'deployment_reference',
	'private_settings_shape',
	'state'
]);
const HERMES_INSTALLER_KEYS = new Set(['present', 'expected_commit_matches', 'offline_checked']);
const HERMES_DEPLOYMENT_KEYS = new Set(['unit_examples_present', 'private_env_reference_present', 'restrictive_mode_present']);
const HERMES_SETTINGS_KEYS = new Set(['schema_version', 'required_setting_count', 'supplied_value_count', 'values_recorded']);

const INVENTORY_FILES = Object.freeze([
	['SOURCE_OF_TRUTH.md', ['DATABASE_URL', 'hermes_runs', 'Hydra', 'No database connection']],
	['src/lib/server/db/schema.ts', ['hermes_runs', 'hermes_run_events', 'accounts']],
	['drizzle/0015_durable_hermes_runs.sql', ['CREATE TABLE IF NOT EXISTS hermes_runs', 'hermes_run_events']],
	['services/hermes-chat/README.md', ['tenant', 'browser', 'restart']],
	['services/hermes-chat/src/hermes_chat/isolation.py', ['TenantRuntime', 'browser_profile']],
	['services/hermes-chat/scripts/install-runtime.sh', ['EXPECTED_HERMES_COMMIT', 'uv pip install']]
]);

class RecoveryMatrixError extends Error {
	constructor(code) {
		super(code);
		this.name = 'RecoveryMatrixError';
		this.code = code;
	}
}

function fail(code) {
	throw new RecoveryMatrixError(code);
}

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
	if (!isObject(value)) fail(`${label}_must_be_object`);
}

function assertExactKeys(value, allowed, label) {
	assertObject(value, label);
	const keys = Object.keys(value);
	if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
		fail(`${label}_schema_invalid`);
	}
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
	if (isObject(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function isSha(value) {
	return typeof value === 'string' && SHA_RE.test(value);
}

function isDigest(value) {
	return typeof value === 'string' && DIGEST_RE.test(value);
}

function isNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

function isPrivateMode(mode) {
	return mode === 0o600;
}

function isPrivateDirectoryMode(mode) {
	return mode === 0o700;
}

function assertNoSensitiveValue(value) {
	if (typeof value === 'string' && SENSITIVE_VALUE_RE.test(value)) {
		fail('secret_bearing_value');
	}
	if (Array.isArray(value)) {
		for (const item of value) assertNoSensitiveValue(item);
		return;
	}
	if (isObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			if (/(?:^|_)(?:password|token|cookie|secret|credential|authorization|database_url|prompt|answer_body|account_id|tenant_key|url)(?:$|_)/i.test(key)) {
				fail('secret_bearing_field');
			}
			assertNoSensitiveValue(child);
		}
	}
}

function assertRecordTimestamp(value, label) {
	if (typeof value !== 'string' || !UTC_TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) {
		fail(`${label}_invalid`);
	}
}

function assertRecordInteger(value, label, maximum = 1_000_000) {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(`${label}_invalid`);
}

function assertRecordBoolean(value, label) {
	if (typeof value !== 'boolean') fail(`${label}_invalid`);
}

function assertRecordSha(value, label, { nullable = false } = {}) {
	if (nullable && value === null) return;
	if (!isSha(value)) fail(`${label}_invalid`);
}

function assertRecordDigest(value, label, { nullable = false } = {}) {
	if (nullable && value === null) return;
	if (!isDigest(value)) fail(`${label}_invalid`);
}

function assertRecordBranch(value, label) {
	if (value !== null && !JIG184_ALLOWED_BRANCHES.includes(value)) fail(`${label}_invalid`);
}

function assertExactArray(value, expected, label) {
	if (!Array.isArray(value) || stableJson(value) !== stableJson(expected)) fail(`${label}_invalid`);
}

function parseFreshTimestamp(value, now) {
	if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) fail('timestamp_invalid');
	const timestamp = Date.parse(value);
	if (timestamp > now + CLOCK_SKEW_MS) fail('timestamp_in_future');
	if (now - timestamp > MAX_EVIDENCE_AGE_MS) fail('evidence_stale');
	return timestamp;
}

function safeRelativePath(value) {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > 240 ||
		value.includes('\\') ||
		value.includes('\0') ||
		value.startsWith('/') ||
		!SAFE_RELATIVE_PATH_RE.test(value) ||
		posix.normalize(value) !== value
	) {
		fail('relative_path_invalid');
	}
	const parts = value.split('/');
	if (parts.some((part) => !part || part === '.' || part === '..')) fail('relative_path_invalid');
	return value;
}

function pathIsWithin(root, candidate) {
	const rootPath = resolve(root);
	const candidatePath = resolve(candidate);
	const path = relative(rootPath, candidatePath);
	return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

function assertNoSymlinkAncestors(path, stopAt) {
	let current = resolve(path);
	const stop = resolve(stopAt);
	let targetExists = false;
	while (true) {
		const stats = lstatOrNull(current);
		if (stats?.isSymbolicLink()) fail('symlink_path_component');
		if (current === resolve(path) && stats) targetExists = true;
		if (current === stop) break;
		const parent = dirname(current);
		if (parent === current) fail('path_anchor_missing');
		current = parent;
	}
	return targetExists;
}

/**
 * Resolve only inside the ignored JIG-184 artifact root. Every existing
 * component is lstat-checked, so a symlink cannot redirect an input or
 * output operation. New files use O_NOFOLLOW as a second defense.
 */
export function assertSafeArtifactPath(path, { repoRoot = REPO_ROOT, mustExist = false } = {}) {
	const artifactRoot = resolve(repoRoot, SAFE_ARTIFACT_RELATIVE_ROOT);
	const candidate = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
	if (!pathIsWithin(artifactRoot, candidate)) fail('artifact_path_outside_dedicated_root');
	const repo = resolve(repoRoot);
	assertNoSymlinkAncestors(candidate, repo);
	const exists = lstatOrNull(candidate);
	if (mustExist && !exists) fail('artifact_path_missing');
	if (exists?.isSymbolicLink()) fail('artifact_path_symlink');
	if (exists && artifactRoot !== candidate && !pathIsWithin(artifactRoot, candidate)) {
		fail('artifact_path_outside_dedicated_root');
	}
	return candidate;
}

async function ensurePrivateDirectory(directory) {
	const target = resolve(directory);
	const missing = [];
	let current = target;
	while (true) {
		const stats = await lstatOrNullAsync(current);
		if (stats) {
			if (stats.isSymbolicLink()) fail('symlink_directory_component');
			if (!stats.isDirectory()) fail('directory_component_not_directory');
			break;
		}
		missing.push(current);
		const parent = dirname(current);
		if (parent === current) fail('directory_anchor_missing');
		current = parent;
	}
	for (const path of missing.reverse()) {
		await mkdir(path, { mode: 0o700 });
		const stats = await lstat(path);
		if (stats.isSymbolicLink() || !stats.isDirectory()) fail('directory_creation_unsafe');
		await chmod(path, 0o700);
	}
	const finalStats = await lstat(target);
	if (finalStats.isSymbolicLink() || !finalStats.isDirectory()) fail('directory_creation_unsafe');
	await chmod(target, 0o700);
	return target;
}

async function lstatOrNullAsync(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

async function assertPrivateDirectory(directory) {
	const stats = await lstatOrNullAsync(directory);
	if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) fail('private_directory_invalid');
	if (!isPrivateDirectoryMode(stats.mode & 0o777)) fail('private_directory_mode_invalid');
}

async function assertSafeTreePath(root, relativePath, { mustExist = false } = {}) {
	const rootPath = resolve(root);
	await assertPrivateDirectory(rootPath);
	const safePath = safeRelativePath(relativePath);
	let current = rootPath;
	const parts = safePath.split('/');
	for (let index = 0; index < parts.length; index += 1) {
		current = join(current, parts[index]);
		const stats = await lstatOrNullAsync(current);
		const final = index === parts.length - 1;
		if (!stats) {
			if (final && !mustExist) return current;
			fail('input_path_missing');
		}
		if (stats.isSymbolicLink()) fail('symlink_path_component');
		if (!final && !stats.isDirectory()) fail('path_component_not_directory');
	}
	return current;
}

async function readPrivateFile(root, relativePath) {
	const target = await assertSafeTreePath(root, relativePath, { mustExist: true });
	const stats = await lstatOrNullAsync(target);
	if (!stats || !stats.isFile() || stats.nlink !== 1) fail('input_file_not_private');
	let handle;
	try {
		handle = await open(target, constants.O_RDONLY | NOFOLLOW);
		return await handle.readFile();
	} finally {
		if (handle) await handle.close();
	}
}

async function writePrivateFileAbsolute(target, data, { replace = false } = {}) {
	await ensurePrivateDirectory(dirname(target));
	const existing = await lstatOrNullAsync(target);
	if (existing?.isSymbolicLink()) fail('output_symlink');
	if (existing && !existing.isFile()) fail('output_not_regular_file');
	if (existing && existing.nlink !== 1) fail('output_hardlink');
	if (existing && !replace) fail('output_already_exists');
	const flags = constants.O_WRONLY | constants.O_CREAT | (replace ? constants.O_TRUNC : constants.O_EXCL) | NOFOLLOW;
	let handle;
	try {
		handle = await open(target, flags, 0o600);
		await handle.writeFile(data);
	} finally {
		if (handle) await handle.close();
	}
	await chmod(target, 0o600);
}

async function writePrivateFile(root, relativePath, data, { replace = false } = {}) {
	const safePath = safeRelativePath(relativePath);
	const parts = safePath.split('/');
	const parent = parts.slice(0, -1).join('/');
	if (parent) await ensurePrivateDirectory(join(root, parent));
	const target = await assertSafeTreePath(root, safePath);
	await writePrivateFileAbsolute(target, data, { replace });
	return target;
}

async function listPrivateFiles(root, prefix = '') {
	await assertPrivateDirectory(root);
	const entries = await readdir(root, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		const target = join(root, entry.name);
		const stats = await lstatOrNullAsync(target);
		if (!stats || stats.isSymbolicLink()) fail('backup_tree_symlink');
		if (stats.isDirectory()) {
			if (!isPrivateDirectoryMode(stats.mode & 0o777)) fail('backup_directory_mode_invalid');
			files.push(...await listPrivateFiles(target, relativePath));
		} else if (stats.isFile()) {
			if (stats.nlink !== 1 || !isPrivateMode(stats.mode & 0o777)) fail('backup_file_mode_or_link_invalid');
			files.push(relativePath);
		} else {
			fail('backup_entry_type_invalid');
		}
	}
	return files;
}

function tenantManifestCore(manifest) {
	return {
		schema_version: manifest.schema_version,
		ticket: manifest.ticket,
		candidate_sha: manifest.candidate_sha,
		source_sha: manifest.source_sha,
		captured_at: manifest.captured_at,
		scope: manifest.scope,
		files: manifest.files
	};
}

export function createTenantManifest({ candidateSha, sourceSha = candidateSha, capturedAt, scope = SYNTHETIC_SCOPE, files }) {
	const manifest = {
		schema_version: JIG184_EVIDENCE_SCHEMA_VERSION,
		ticket: JIG184_TICKET,
		candidate_sha: candidateSha,
		source_sha: sourceSha,
		captured_at: capturedAt,
		scope,
		files
	};
	return { ...manifest, manifest_sha256: sha256(stableJson(tenantManifestCore(manifest))) };
}

export function validateTenantManifest(manifest, { candidateSha, sourceSha = candidateSha, expectedScope = SYNTHETIC_SCOPE, now = Date.now() } = {}) {
	assertExactKeys(manifest, TENANT_MANIFEST_KEYS, 'tenant_manifest');
	if (manifest.schema_version !== JIG184_EVIDENCE_SCHEMA_VERSION || manifest.ticket !== JIG184_TICKET) fail('tenant_manifest_identity_invalid');
	if (!isSha(candidateSha) || manifest.candidate_sha !== candidateSha || !isSha(manifest.source_sha) || manifest.source_sha !== sourceSha) {
		fail('tenant_manifest_revision_mismatch');
	}
	if (!SAFE_SYNTHETIC_SCOPE_RE.test(manifest.scope) || manifest.scope !== expectedScope) fail('tenant_manifest_scope_mismatch');
	parseFreshTimestamp(manifest.captured_at, now);
	if (!Array.isArray(manifest.files) || manifest.files.length !== 2) fail('tenant_manifest_file_count_invalid');
	if (manifest.manifest_sha256 !== sha256(stableJson(tenantManifestCore(manifest)))) fail('tenant_manifest_digest_invalid');
	const seen = new Set();
	const kinds = new Set();
	for (const file of manifest.files) {
		assertExactKeys(file, TENANT_FILE_KEYS, 'tenant_manifest_file');
		const relativePath = safeRelativePath(file.relative_path);
		if (seen.has(relativePath)) fail('tenant_manifest_duplicate_file');
		seen.add(relativePath);
		if (!['workspace/state.json', 'browser/state.json'].includes(relativePath)) fail('tenant_manifest_file_scope_invalid');
		if (!['workspace', 'browser_state'].includes(file.kind) || kinds.has(file.kind)) fail('tenant_manifest_file_kind_invalid');
		kinds.add(file.kind);
		if (!isDigest(file.sha256) || file.mode !== 0o600) fail('tenant_manifest_file_integrity_invalid');
	}
	if (!seen.has('workspace/state.json') || !seen.has('browser/state.json')) fail('tenant_manifest_scope_incomplete');
	assertNoSensitiveValue(manifest);
	return manifest;
}

export async function restoreTenantBackup({ backupRoot, restoreRoot, manifest = null, candidateSha, sourceSha = candidateSha, expectedScope = SYNTHETIC_SCOPE, now = Date.now() } = {}) {
	await assertPrivateDirectory(backupRoot);
	await ensurePrivateDirectory(restoreRoot);
	const existingRestoreEntries = await readdir(restoreRoot);
	if (existingRestoreEntries.length !== 0) fail('restore_destination_not_empty');
	const manifestValue = manifest ?? JSON.parse((await readPrivateFile(backupRoot, 'manifest.json')).toString('utf8'));
	validateTenantManifest(manifestValue, { candidateSha, sourceSha, expectedScope, now });
	const actualFiles = await listPrivateFiles(backupRoot);
	const expectedFiles = new Set(['manifest.json', ...manifestValue.files.map((file) => file.relative_path)]);
	if (actualFiles.length !== expectedFiles.size || actualFiles.some((file) => !expectedFiles.has(file))) fail('backup_tree_contains_unlisted_artifact');
	const scopeRoot = join(restoreRoot, manifestValue.scope);
	await ensurePrivateDirectory(scopeRoot);
	for (const file of manifestValue.files) {
		const bytes = await readPrivateFile(backupRoot, file.relative_path);
		if (sha256(bytes) !== file.sha256) fail('tenant_backup_file_digest_invalid');
		assertNoSensitiveValue(bytes.toString('utf8'));
		await writePrivateFile(scopeRoot, file.relative_path, bytes);
	}
	const restoredFiles = await listPrivateFiles(scopeRoot);
	if (restoredFiles.length !== manifestValue.files.length || restoredFiles.some((file) => !expectedFiles.has(file))) fail('restore_file_set_invalid');
	for (const file of manifestValue.files) {
		const restored = await readPrivateFile(scopeRoot, file.relative_path);
		const stats = await lstatOrNullAsync(join(scopeRoot, file.relative_path));
		if (sha256(restored) !== file.sha256 || !stats || !isPrivateMode(stats.mode & 0o777)) fail('restored_file_integrity_invalid');
	}
	return {
		state: 'PASS',
		restored_file_count: restoredFiles.length,
		selected_scope_count: 1,
		private_modes: true,
		manifest_integrity: true
	};
}

async function createSyntheticTenantBackup(root, candidateSha, now) {
	const sourceRoot = join(root, 'source');
	const backupRoot = join(root, 'backup');
	const restoreRoot = join(root, 'restore');
	await ensurePrivateDirectory(sourceRoot);
	await ensurePrivateDirectory(backupRoot);
	await ensurePrivateDirectory(restoreRoot);
	const safeWorkspace = Buffer.from('{"kind":"local-workspace-fixture","revision":1}\n');
	const safeBrowser = Buffer.from('{"kind":"local-browser-fixture","revision":1}\n');
	const foreignWorkspace = Buffer.from('{"kind":"excluded-workspace-fixture","revision":1}\n');
	const foreignBrowser = Buffer.from('{"kind":"excluded-browser-fixture","revision":1}\n');
	await writePrivateFile(sourceRoot, `${SYNTHETIC_SCOPE}/workspace/state.json`, safeWorkspace);
	await writePrivateFile(sourceRoot, `${SYNTHETIC_SCOPE}/browser/state.json`, safeBrowser);
	await writePrivateFile(sourceRoot, 'synthetic-tenant-b/workspace/state.json', foreignWorkspace);
	await writePrivateFile(sourceRoot, 'synthetic-tenant-b/browser/state.json', foreignBrowser);
	await writePrivateFile(backupRoot, 'workspace/state.json', safeWorkspace);
	await writePrivateFile(backupRoot, 'browser/state.json', safeBrowser);
	const files = [
		{ relative_path: 'workspace/state.json', kind: 'workspace', sha256: sha256(safeWorkspace), mode: 0o600 },
		{ relative_path: 'browser/state.json', kind: 'browser_state', sha256: sha256(safeBrowser), mode: 0o600 }
	];
	const manifest = createTenantManifest({
		candidateSha,
		capturedAt: new Date(now).toISOString(),
		files
	});
	await writePrivateFile(backupRoot, 'manifest.json', Buffer.from(`${stableJson(manifest)}\n`));
	return { sourceRoot, backupRoot, restoreRoot, manifest };
}

export async function runSyntheticTenantRestoreDrill(candidateSha, { now = Date.now() } = {}) {
	if (!isSha(candidateSha)) fail('candidate_revision_invalid');
	const root = await mkdtemp(join(tmpdir(), 'newscraft-jig184-'));
	await chmod(root, 0o700);
	const started = performance.now();
	try {
		const fixture = await createSyntheticTenantBackup(root, candidateSha, now);
		const result = await restoreTenantBackup({
			backupRoot: fixture.backupRoot,
			restoreRoot: fixture.restoreRoot,
			candidateSha,
			now
		});
		const restoredForeign = lstatOrNull(join(fixture.restoreRoot, 'synthetic-tenant-b'));
		if (restoredForeign) fail('foreign_scope_restored');
		const sourceFiles = await listPrivateFiles(join(fixture.sourceRoot, SYNTHETIC_SCOPE));
		if (sourceFiles.length !== 2) fail('synthetic_source_fixture_invalid');
		return {
			...result,
			duration_ms: Math.max(0, Math.round(performance.now() - started)),
			excluded_scope_count: 1,
			backup_file_count: 2,
			cross_scope_content: false
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

export function validatePostgresRestoreEvidence(evidence, { candidateSha, now = Date.now() } = {}) {
	assertExactKeys(evidence, POSTGRES_EVIDENCE_KEYS, 'postgres_restore_evidence');
	if (
		evidence.schema_version !== JIG184_EVIDENCE_SCHEMA_VERSION ||
		evidence.ticket !== JIG184_TICKET ||
		!isSha(candidateSha) ||
		evidence.candidate_sha !== candidateSha ||
		evidence.source_sha !== candidateSha
	) fail('postgres_restore_revision_mismatch');
	parseFreshTimestamp(evidence.captured_at, now);
	if (
		evidence.execution !== 'isolated-test-postgres-restore' ||
		evidence.scope !== 'disposable-loopback-test-only' ||
		evidence.test_identity !== 'dedicated-fixture-only' ||
		evidence.loopback !== true ||
		evidence.isolated !== true ||
		evidence.test_data_only !== true ||
		evidence.state !== 'PASS'
	) fail('postgres_restore_scope_invalid');
	assertExactKeys(evidence.schema, POSTGRES_SCHEMA_KEYS, 'postgres_restore_schema');
	assertExactKeys(evidence.rows, POSTGRES_ROWS_KEYS, 'postgres_restore_rows');
	assertExactKeys(evidence.isolation, POSTGRES_ISOLATION_KEYS, 'postgres_restore_isolation');
	if (!isNonNegativeInteger(evidence.schema.migration_revision_count) || !isDigest(evidence.schema.schema_digest)) fail('postgres_restore_schema_aggregate_invalid');
	if (!isNonNegativeInteger(evidence.rows.table_count) || !isNonNegativeInteger(evidence.rows.row_count) || !isDigest(evidence.rows.aggregate_digest)) fail('postgres_restore_row_aggregate_invalid');
	if (evidence.rows.table_count < 1 || evidence.isolation.selected_scope_count !== 1 || evidence.isolation.foreign_scope_count !== 0) fail('postgres_restore_isolation_failed');
	assertNoSensitiveValue(evidence);
	return evidence;
}

export function validateHermesOfflineEvidence(evidence, { candidateSha, now = Date.now() } = {}) {
	assertExactKeys(evidence, HERMES_EVIDENCE_KEYS, 'hermes_offline_evidence');
	if (
		evidence.schema_version !== JIG184_EVIDENCE_SCHEMA_VERSION ||
		evidence.ticket !== JIG184_TICKET ||
		!isSha(candidateSha) ||
		evidence.candidate_sha !== candidateSha ||
		evidence.source_sha !== candidateSha
	) fail('hermes_offline_revision_mismatch');
	parseFreshTimestamp(evidence.captured_at, now);
	if (evidence.execution !== 'repository-offline-checks' || evidence.source_commit !== HERMES_REVIEWED_COMMIT || !isDigest(evidence.lock_digest) || evidence.state !== 'PASS') fail('hermes_offline_identity_invalid');
	assertExactKeys(evidence.installer_reference, HERMES_INSTALLER_KEYS, 'hermes_installer_reference');
	assertExactKeys(evidence.deployment_reference, HERMES_DEPLOYMENT_KEYS, 'hermes_deployment_reference');
	assertExactKeys(evidence.private_settings_shape, HERMES_SETTINGS_KEYS, 'hermes_settings_shape');
	if (!Object.values(evidence.installer_reference).every((value) => value === true) || !Object.values(evidence.deployment_reference).every((value) => value === true)) fail('hermes_offline_reference_invalid');
	if (
		evidence.private_settings_shape.schema_version !== 1 ||
		evidence.private_settings_shape.required_setting_count < 1 ||
		evidence.private_settings_shape.supplied_value_count !== 0 ||
		evidence.private_settings_shape.values_recorded !== false
	) fail('hermes_private_shape_invalid');
	assertNoSensitiveValue(evidence);
	return evidence;
}

function safeGitEnvironment() {
	const environment = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
	for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
		if (typeof process.env[name] === 'string' && process.env[name]) environment[name] = process.env[name];
	}
	return environment;
}

function runGit(repoRoot, args) {
	const result = spawnSync('git', args, {
		cwd: repoRoot,
		env: safeGitEnvironment(),
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
	if (result.status !== 0) fail('git_identity_command_failed');
	return String(result.stdout ?? '').trim();
}

function gitSucceeds(repoRoot, args) {
	const result = spawnSync('git', args, {
		cwd: repoRoot,
		env: safeGitEnvironment(),
		stdio: ['ignore', 'ignore', 'ignore']
	});
	return result.status === 0;
}

export function checkoutIdentity(repoRoot = REPO_ROOT) {
	const sourceSha = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']);
	const status = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
	const basePresent = gitSucceeds(repoRoot, ['cat-file', '-e', `${JIG184_BASE_SHA}^{commit}`]);
	const commitPresent = isSha(sourceSha) && gitSucceeds(repoRoot, ['cat-file', '-e', `${sourceSha}^{commit}`]);
	const baseIsAncestor = basePresent && commitPresent && gitSucceeds(repoRoot, ['merge-base', '--is-ancestor', JIG184_BASE_SHA, sourceSha]);
	return {
		branch: runGit(repoRoot, ['branch', '--show-current']),
		source_sha: sourceSha,
		base_sha: JIG184_BASE_SHA,
		clean: status.length === 0,
		base_present: basePresent,
		commit_present: commitPresent,
		base_is_ancestor: baseIsAncestor
	};
}

export function validateCheckoutIdentity(identity, expectedSourceSha, expectedCandidateSha, actual = identity) {
	assertObject(identity, 'checkout_identity');
	assertObject(actual, 'actual_checkout_identity');
	if (!isSha(expectedSourceSha) || !isSha(expectedCandidateSha)) fail('expected_revision_must_be_full_sha');
	if (expectedSourceSha !== expectedCandidateSha) fail('source_and_candidate_revisions_must_match');
	for (const key of ['branch', 'source_sha', 'base_sha', 'clean', 'base_present', 'commit_present', 'base_is_ancestor']) {
		if (identity[key] !== actual[key]) fail('checkout_identity_changed');
	}
	if (!JIG184_ALLOWED_BRANCHES.includes(actual.branch)) fail('branch_not_authorized');
	if (actual.base_sha !== JIG184_BASE_SHA) fail('verified_base_mismatch');
	if (actual.clean !== true) fail('checkout_not_clean');
	if (actual.base_present !== true || actual.commit_present !== true || actual.base_is_ancestor !== true) fail('checkout_ancestry_invalid');
	if (actual.source_sha !== expectedSourceSha || actual.source_sha !== expectedCandidateSha || !isSha(actual.source_sha)) fail('candidate_does_not_match_clean_head');
	return true;
}

async function readRepositoryText(repoRoot, relativePath) {
	const target = resolve(repoRoot, relativePath);
	if (!pathIsWithin(repoRoot, target)) fail('repository_reference_outside_root');
	const stats = await lstatOrNullAsync(target);
	if (!stats || stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) fail('repository_reference_invalid');
	return readFile(target, 'utf8');
}

export async function buildScopeInventory(repoRoot = REPO_ROOT) {
	for (const [relativePath, needles] of INVENTORY_FILES) {
		const text = await readRepositoryText(repoRoot, relativePath);
		if (!needles.every((needle) => text.includes(needle))) fail('repository_scope_reference_missing');
	}
	return {
		state: 'PASS',
		repository_reference_count: INVENTORY_FILES.length,
		postgres_relation_groups: 3,
		hermes_state_areas: 5,
		live_backup_facts: 'BLOCKED',
		live_host_facts: 'BLOCKED',
		hydra_boundary: 'OUTSIDE_SCOPE'
	};
}

export async function buildHermesOfflineEvidence(repoRoot = REPO_ROOT, candidateSha, now = Date.now()) {
	if (!isSha(candidateSha)) fail('candidate_revision_invalid');
	const init = await readRepositoryText(repoRoot, 'services/hermes-chat/src/hermes_chat/__init__.py');
	const installer = await readRepositoryText(repoRoot, 'services/hermes-chat/scripts/install-runtime.sh');
	const pyproject = await readRepositoryText(repoRoot, 'services/hermes-chat/pyproject.toml');
	const lock = await readRepositoryText(repoRoot, 'services/hermes-chat/uv.lock');
	const serviceUnit = await readRepositoryText(repoRoot, 'services/hermes-chat/deploy/newscraft-hermes-chat.service');
	const userUnit = await readRepositoryText(repoRoot, 'services/hermes-chat/deploy/newscraft-hermes-chat.user.service');
	const expectedCommitMatches = init.includes(HERMES_REVIEWED_COMMIT) && installer.includes(`EXPECTED_HERMES_COMMIT="${HERMES_REVIEWED_COMMIT}"`);
	const packageShape = pyproject.includes('name = "newscraft-hermes-chat"') && pyproject.includes('requires-python = ">=3.11"');
	const lockShape = lock.includes('revision = 3') && lock.includes('requires-python = ">=3.11"');
	const installShape = installer.includes('uv pip install') && installer.includes('agui_adapter.server') && installer.includes('hermes_chat.service');
	const deploymentShape = [serviceUnit, userUnit].every((unit) => unit.includes('EnvironmentFile=') && unit.includes('ExecStart=') && unit.includes('UMask=0077'));
	if (!expectedCommitMatches || !packageShape || !lockShape || !installShape || !deploymentShape) fail('hermes_repository_reference_invalid');
	const evidence = {
		schema_version: JIG184_EVIDENCE_SCHEMA_VERSION,
		ticket: JIG184_TICKET,
		candidate_sha: candidateSha,
		source_sha: candidateSha,
		captured_at: new Date(now).toISOString(),
		execution: 'repository-offline-checks',
		source_commit: HERMES_REVIEWED_COMMIT,
		lock_digest: sha256(lock),
		installer_reference: { present: true, expected_commit_matches: true, offline_checked: true },
		deployment_reference: { unit_examples_present: true, private_env_reference_present: true, restrictive_mode_present: true },
		private_settings_shape: { schema_version: 1, required_setting_count: 7, supplied_value_count: 0, values_recorded: false },
		state: 'PASS'
	};
	return validateHermesOfflineEvidence(evidence, { candidateSha, now });
}

function validateReleaseCheckoutRecord(checkout) {
	assertExactKeys(checkout, RELEASE_CHECKOUT_KEYS, 'release_checkout');
	assertRecordBranch(checkout.branch, 'release_checkout_branch');
	assertRecordSha(checkout.source_sha, 'release_checkout_source_sha', { nullable: true });
	if (checkout.base_sha !== null && checkout.base_sha !== JIG184_BASE_SHA) fail('release_checkout_base_sha_invalid');
	for (const key of ['clean', 'base_present', 'commit_present', 'base_is_ancestor']) {
		assertRecordBoolean(checkout[key], `release_checkout_${key}`);
	}
}

function validateReleaseInventoryRecord(inventory) {
	assertExactKeys(inventory, RELEASE_INVENTORY_KEYS, 'release_inventory');
	if (!['PASS', 'FAIL'].includes(inventory.state)) fail('release_inventory_state_invalid');
	assertRecordInteger(inventory.repository_reference_count, 'release_inventory_reference_count', INVENTORY_FILES.length);
	assertRecordInteger(inventory.postgres_relation_groups, 'release_inventory_postgres_groups', 3);
	assertRecordInteger(inventory.hermes_state_areas, 'release_inventory_hermes_areas', 5);
	if (inventory.live_backup_facts !== 'BLOCKED' || inventory.live_host_facts !== 'BLOCKED' || inventory.hydra_boundary !== 'OUTSIDE_SCOPE') {
		fail('release_inventory_boundary_invalid');
	}
	if (
		inventory.state === 'PASS' &&
		(inventory.repository_reference_count !== INVENTORY_FILES.length ||
			inventory.postgres_relation_groups !== 3 ||
			inventory.hermes_state_areas !== 5)
	) {
		fail('release_inventory_pass_evidence_invalid');
	}
}

function validateReleaseSyntheticRecord(syntheticRestore) {
	assertExactKeys(syntheticRestore, RELEASE_SYNTHETIC_KEYS, 'release_synthetic_restore');
	if (!['PASS', 'FAIL'].includes(syntheticRestore.state)) fail('release_synthetic_state_invalid');
	for (const key of ['restored_file_count', 'selected_scope_count', 'excluded_scope_count', 'backup_file_count']) {
		assertRecordInteger(syntheticRestore[key], `release_synthetic_${key}`, 2);
	}
	assertRecordInteger(syntheticRestore.duration_ms, 'release_synthetic_duration', 86_400_000);
	for (const key of ['private_modes', 'manifest_integrity', 'cross_scope_content']) {
		assertRecordBoolean(syntheticRestore[key], `release_synthetic_${key}`);
	}
	if (
		syntheticRestore.state === 'PASS' &&
		(syntheticRestore.restored_file_count !== 2 ||
			syntheticRestore.selected_scope_count !== 1 ||
			syntheticRestore.excluded_scope_count !== 1 ||
			syntheticRestore.backup_file_count !== 2 ||
			syntheticRestore.private_modes !== true ||
			syntheticRestore.manifest_integrity !== true ||
			syntheticRestore.cross_scope_content !== false)
	) {
		fail('release_synthetic_pass_evidence_invalid');
	}
}

function validateReleaseHermesRecord(hermesChecks) {
	assertExactKeys(hermesChecks, HERMES_EVIDENCE_KEYS, 'release_hermes_offline_checks');
	if (
		hermesChecks.schema_version !== JIG184_EVIDENCE_SCHEMA_VERSION ||
		hermesChecks.ticket !== JIG184_TICKET ||
		hermesChecks.execution !== 'repository-offline-checks'
	) fail('release_hermes_identity_invalid');
	assertRecordSha(hermesChecks.candidate_sha, 'release_hermes_candidate_sha', { nullable: true });
	assertRecordSha(hermesChecks.source_sha, 'release_hermes_source_sha', { nullable: true });
	assertRecordTimestamp(hermesChecks.captured_at, 'release_hermes_captured_at');
	assertRecordSha(hermesChecks.source_commit, 'release_hermes_source_commit', { nullable: true });
	assertRecordDigest(hermesChecks.lock_digest, 'release_hermes_lock_digest', { nullable: true });
	assertExactKeys(hermesChecks.installer_reference, HERMES_INSTALLER_KEYS, 'release_hermes_installer_reference');
	assertExactKeys(hermesChecks.deployment_reference, HERMES_DEPLOYMENT_KEYS, 'release_hermes_deployment_reference');
	assertExactKeys(hermesChecks.private_settings_shape, HERMES_SETTINGS_KEYS, 'release_hermes_private_settings_shape');
	for (const value of Object.values(hermesChecks.installer_reference)) assertRecordBoolean(value, 'release_hermes_installer_flag');
	for (const value of Object.values(hermesChecks.deployment_reference)) assertRecordBoolean(value, 'release_hermes_deployment_flag');
	if (hermesChecks.private_settings_shape.schema_version !== 1) fail('release_hermes_settings_schema_invalid');
	assertRecordInteger(hermesChecks.private_settings_shape.required_setting_count, 'release_hermes_required_settings', 32);
	if (hermesChecks.private_settings_shape.supplied_value_count !== 0 || hermesChecks.private_settings_shape.values_recorded !== false) {
		fail('release_hermes_private_values_present');
	}
	if (hermesChecks.state === 'PASS') {
		if (
			!isSha(hermesChecks.candidate_sha) ||
			hermesChecks.source_sha !== hermesChecks.candidate_sha ||
			hermesChecks.source_commit !== HERMES_REVIEWED_COMMIT ||
			!isDigest(hermesChecks.lock_digest) ||
			!Object.values(hermesChecks.installer_reference).every((value) => value === true) ||
			!Object.values(hermesChecks.deployment_reference).every((value) => value === true) ||
			hermesChecks.private_settings_shape.required_setting_count !== 7
		) fail('release_hermes_pass_evidence_invalid');
	} else if (hermesChecks.state === 'FAIL') {
		if (
			hermesChecks.candidate_sha !== null ||
			hermesChecks.source_sha !== null ||
			hermesChecks.source_commit !== null ||
			hermesChecks.lock_digest !== null ||
			Object.values(hermesChecks.installer_reference).some((value) => value !== false) ||
			Object.values(hermesChecks.deployment_reference).some((value) => value !== false) ||
			hermesChecks.private_settings_shape.required_setting_count !== 0
		) fail('release_hermes_failure_evidence_invalid');
	} else {
		fail('release_hermes_state_invalid');
	}
}

function validateReleaseGate(gateValue, index, record) {
	const context = `release_gate_${index}`;
	assertObject(gateValue, context);
	const definition = RELEASE_GATE_DEFINITIONS[gateValue.id];
	if (!definition) fail('release_gate_id_invalid');
	const isExternal = ['isolated_postgres_snapshot_restore', 'pinned_hermes_rebuild_start_readiness', 'host_loss_recovery_time'].includes(gateValue.id);
	if (isExternal && gateValue.state !== 'BLOCKED') fail('release_gate_external_pass_forbidden');
	if (!isExternal && !['PASS', 'FAIL'].includes(gateValue.state)) fail('release_gate_state_invalid');
	const allowedKeys = new Set(RELEASE_GATE_BASE_KEYS);
	if (gateValue.state === 'PASS' && ['synthetic_tenant_restore', 'hermes_offline_repository_checks'].includes(gateValue.id)) {
		allowedKeys.add('evidence');
	} else if (gateValue.state !== 'PASS') {
		allowedKeys.add('reason');
	}
	assertExactKeys(gateValue, allowedKeys, context);
	if (gateValue.scope !== definition.scope || gateValue.evidence_id !== `jig184-${gateValue.id}-${sha256(`${gateValue.id}:${gateValue.scope}`).slice(0, 16)}`) fail('release_gate_binding_invalid');
	if (gateValue.state !== 'PASS') {
		if (gateValue.reason !== definition.failure) fail('release_gate_reason_invalid');
		return;
	}
	if (isExternal) fail('release_gate_external_pass_forbidden');
	if (gateValue.id === 'synthetic_tenant_restore') {
		assertExactKeys(gateValue.evidence, RELEASE_SYNTHETIC_GATE_EVIDENCE_KEYS, `${context}_evidence`);
		for (const key of ['restored_file_count', 'selected_scope_count', 'excluded_scope_count']) assertRecordInteger(gateValue.evidence[key], `${context}_${key}`, 2);
		assertRecordInteger(gateValue.evidence.duration_ms, `${context}_duration`, 86_400_000);
		for (const key of ['private_modes', 'manifest_integrity', 'cross_scope_content']) assertRecordBoolean(gateValue.evidence[key], `${context}_${key}`);
		const expected = {
			restored_file_count: record.synthetic_restore.restored_file_count,
			selected_scope_count: record.synthetic_restore.selected_scope_count,
			excluded_scope_count: record.synthetic_restore.excluded_scope_count,
			private_modes: record.synthetic_restore.private_modes,
			manifest_integrity: record.synthetic_restore.manifest_integrity,
			cross_scope_content: record.synthetic_restore.cross_scope_content,
			duration_ms: record.synthetic_restore.duration_ms
		};
		if (stableJson(gateValue.evidence) !== stableJson(expected)) fail('release_gate_evidence_mismatch');
	} else if (gateValue.id === 'hermes_offline_repository_checks') {
		assertExactKeys(gateValue.evidence, RELEASE_HERMES_GATE_EVIDENCE_KEYS, `${context}_evidence`);
		assertRecordSha(gateValue.evidence.source_commit, `${context}_source_commit`);
		assertRecordDigest(gateValue.evidence.lock_digest, `${context}_lock_digest`);
		assertRecordBoolean(gateValue.evidence.installer_checked, `${context}_installer_checked`);
		assertRecordBoolean(gateValue.evidence.deployment_references_checked, `${context}_deployment_checked`);
		const expected = {
			source_commit: record.hermes_offline_checks.source_commit,
			lock_digest: record.hermes_offline_checks.lock_digest,
			installer_checked: record.hermes_offline_checks.installer_reference.offline_checked,
			deployment_references_checked: record.hermes_offline_checks.deployment_reference.unit_examples_present
		};
		if (stableJson(gateValue.evidence) !== stableJson(expected)) fail('release_gate_evidence_mismatch');
	}
}

function validateReleaseGates(gates, record) {
	if (!Array.isArray(gates) || gates.length !== REQUIRED_GATE_IDS.length) fail('release_gate_set_invalid');
	const ids = gates.map((item) => item?.id);
	if (new Set(ids).size !== ids.length || stableJson(ids) !== stableJson([...REQUIRED_GATE_IDS])) fail('release_gate_set_invalid');
	for (const [index, gateValue] of gates.entries()) validateReleaseGate(gateValue, index, record);
	const byId = new Map(gates.map((item) => [item.id, item]));
	const checkout = record.checkout;
	const checkoutPassEvidence =
		JIG184_ALLOWED_BRANCHES.includes(checkout.branch) &&
		isSha(checkout.source_sha) &&
		checkout.base_sha === JIG184_BASE_SHA &&
		checkout.clean === true &&
		checkout.base_present === true &&
		checkout.commit_present === true &&
		checkout.base_is_ancestor === true;
	if (byId.get('checkout_identity').state === 'PASS' && !checkoutPassEvidence) fail('release_checkout_gate_mismatch');
	if (byId.get('backup_scope_inventory').state !== record.inventory.state) fail('release_inventory_gate_mismatch');
	if (byId.get('synthetic_tenant_restore').state !== record.synthetic_restore.state) fail('release_synthetic_gate_mismatch');
	if (byId.get('hermes_offline_repository_checks').state !== record.hermes_offline_checks.state) fail('release_hermes_gate_mismatch');
}

export function validateReleaseRecord(record) {
	assertExactKeys(record, RELEASE_RECORD_KEYS, 'release_record');
	if (record.schema_version !== JIG184_EVIDENCE_SCHEMA_VERSION || record.ticket !== JIG184_TICKET) fail('release_record_identity_invalid');
	assertRecordTimestamp(record.recorded_at, 'release_record_timestamp');
	validateReleaseCheckoutRecord(record.checkout);
	assertExactKeys(record.candidate, RELEASE_CANDIDATE_KEYS, 'release_candidate');
	assertRecordSha(record.candidate.source_sha, 'release_candidate_source_sha', { nullable: true });
	if (record.candidate.source_sha !== record.checkout.source_sha || record.candidate.base_sha !== JIG184_BASE_SHA) fail('release_candidate_binding_invalid');
	validateReleaseInventoryRecord(record.inventory);
	validateReleaseSyntheticRecord(record.synthetic_restore);
	validateReleaseHermesRecord(record.hermes_offline_checks);
	if (record.hermes_offline_checks.state === 'PASS' && record.hermes_offline_checks.candidate_sha !== record.checkout.source_sha) fail('release_hermes_candidate_binding_invalid');
	assertExactArray(record.required_gate_ids, [...REQUIRED_GATE_IDS], 'release_required_gate_ids');
	validateReleaseGates(record.gates, record);
	if (record.release_decision !== 'BLOCK RELEASE' || record.release_exit_code !== 1) fail('release_policy_block_only');
	assertExactArray(record.limitations, [...LOCAL_RELEASE_LIMITATIONS], 'release_limitations');
	assertNoSensitiveValue(record);
	return true;
}

function redactedIdentity(identity) {
	return {
		branch: JIG184_ALLOWED_BRANCHES.includes(identity?.branch) ? identity.branch : null,
		source_sha: isSha(identity?.source_sha) ? identity.source_sha : null,
		base_sha: identity?.base_sha === JIG184_BASE_SHA ? JIG184_BASE_SHA : null,
		clean: identity?.clean === true,
		base_present: identity?.base_present === true,
		commit_present: identity?.commit_present === true,
		base_is_ancestor: identity?.base_is_ancestor === true
	};
}

function gate(id, state, scope, reason = null, evidence = null) {
	if (!REQUIRED_GATE_IDS.includes(id) || !ALLOWED_GATE_STATES.has(state)) fail('release_gate_invalid');
	return {
		id,
		state,
		scope,
		evidence_id: `jig184-${id}-${sha256(`${id}:${scope}`).slice(0, 16)}`,
		...(reason ? { reason } : {}),
		...(evidence ? { evidence } : {})
	};
}

export function releaseExitCode(record) {
	try {
		validateReleaseRecord(record);
	} catch {
		return 1;
	}
	// This command has no external evidence adapter.  Its local release policy
	// is deliberately block-only, so exit 0 is unreachable by this interface.
	return 1;
}

export function assertRedactedReleaseRecord(record) {
	validateReleaseRecord(record);
	return true;
}

function failedHermesOfflineChecks(now) {
	return {
		schema_version: JIG184_EVIDENCE_SCHEMA_VERSION,
		ticket: JIG184_TICKET,
		candidate_sha: null,
		source_sha: null,
		captured_at: new Date(now).toISOString(),
		execution: 'repository-offline-checks',
		source_commit: null,
		lock_digest: null,
		installer_reference: { present: false, expected_commit_matches: false, offline_checked: false },
		deployment_reference: { unit_examples_present: false, private_env_reference_present: false, restrictive_mode_present: false },
		private_settings_shape: { schema_version: 1, required_setting_count: 0, supplied_value_count: 0, values_recorded: false },
		state: 'FAIL'
	};
}

export function buildReleaseRecord({ identity, identityValid, inventory, syntheticRestore, hermesOfflineChecks, now = Date.now() } = {}) {
	const safeIdentity = redactedIdentity(identity);
	const gates = [
		gate('checkout_identity', identityValid ? 'PASS' : 'FAIL', 'local-checkout', identityValid ? null : 'checkout_identity_invalid'),
		gate('backup_scope_inventory', inventory?.state === 'PASS' ? 'PASS' : 'FAIL', 'repository-static', inventory?.state === 'PASS' ? null : 'repository_inventory_invalid'),
		gate('synthetic_tenant_restore', syntheticRestore?.state === 'PASS' ? 'PASS' : 'FAIL', 'disposable-local', syntheticRestore?.state === 'PASS' ? null : 'synthetic_restore_failed', syntheticRestore?.state === 'PASS' ? {
			restored_file_count: syntheticRestore.restored_file_count,
			selected_scope_count: syntheticRestore.selected_scope_count,
			excluded_scope_count: syntheticRestore.excluded_scope_count,
			private_modes: syntheticRestore.private_modes,
			manifest_integrity: syntheticRestore.manifest_integrity,
			cross_scope_content: syntheticRestore.cross_scope_content,
			duration_ms: syntheticRestore.duration_ms
		} : null),
		gate('hermes_offline_repository_checks', hermesOfflineChecks?.state === 'PASS' ? 'PASS' : 'FAIL', 'repository-static', hermesOfflineChecks?.state === 'PASS' ? null : 'hermes_offline_checks_failed', hermesOfflineChecks?.state === 'PASS' ? {
			source_commit: hermesOfflineChecks.source_commit,
			lock_digest: hermesOfflineChecks.lock_digest,
			installer_checked: hermesOfflineChecks.installer_reference.offline_checked,
			deployment_references_checked: hermesOfflineChecks.deployment_reference.unit_examples_present
		} : null),
		gate('isolated_postgres_snapshot_restore', 'BLOCKED', 'external-database-authority', 'isolated_postgres_restore_requires_separately_authorized_test_database_evidence'),
		gate('pinned_hermes_rebuild_start_readiness', 'BLOCKED', 'external-vps-authority', 'pinned_hermes_rebuild_and_readiness_requires_separately_authorized_vps_private_configuration_and_service_evidence'),
		gate('host_loss_recovery_time', 'BLOCKED', 'external-host-authority', 'host_loss_rto_requires_separately_authorized_host_loss_measurement')
	];
	const record = {
		schema_version: JIG184_EVIDENCE_SCHEMA_VERSION,
		ticket: JIG184_TICKET,
		recorded_at: new Date(now).toISOString(),
		checkout: safeIdentity,
		candidate: { source_sha: safeIdentity.source_sha, base_sha: JIG184_BASE_SHA },
		inventory: inventory ?? { state: 'FAIL', repository_reference_count: 0, postgres_relation_groups: 0, hermes_state_areas: 0, live_backup_facts: 'BLOCKED', live_host_facts: 'BLOCKED', hydra_boundary: 'OUTSIDE_SCOPE' },
		synthetic_restore: syntheticRestore ?? { state: 'FAIL', restored_file_count: 0, selected_scope_count: 0, excluded_scope_count: 0, private_modes: false, manifest_integrity: false, cross_scope_content: true, duration_ms: 0, backup_file_count: 0 },
		hermes_offline_checks: hermesOfflineChecks ?? failedHermesOfflineChecks(now),
		required_gate_ids: [...REQUIRED_GATE_IDS],
		gates,
		release_decision: 'BLOCK RELEASE',
		release_exit_code: 1,
		limitations: [...LOCAL_RELEASE_LIMITATIONS]
	};
	assertRedactedReleaseRecord(record);
	return record;
}

export async function writeReleaseRecord(path, record, { repoRoot = REPO_ROOT } = {}) {
	assertRedactedReleaseRecord(record);
	const artifactRoot = resolve(repoRoot, SAFE_ARTIFACT_RELATIVE_ROOT);
	assertSafeArtifactPath(artifactRoot, { repoRoot });
	await ensurePrivateDirectory(artifactRoot);
	const output = assertSafeArtifactPath(path, { repoRoot });
	await ensurePrivateDirectory(dirname(output));
	assertSafeArtifactPath(output, { repoRoot });
	const encoded = `${stableJson(record)}\n`;
	await writePrivateFileAbsolute(output, encoded, { replace: true });
	return { path: output, sha256: sha256(encoded) };
}

function defaultOutputPath(repoRoot, candidateSha) {
	const short = isSha(candidateSha) ? candidateSha.slice(0, 12) : 'invalid';
	return resolve(repoRoot, SAFE_ARTIFACT_RELATIVE_ROOT, `recovery-${short}.json`);
}

function failureIdentity(repoRoot, readIdentity = checkoutIdentity) {
	try {
		return readIdentity(repoRoot);
	} catch {
		return { branch: null, source_sha: null, base_sha: null, clean: false, base_present: false, commit_present: false, base_is_ancestor: false };
	}
}

function checkoutIdentitiesMatch(first, second) {
	return CHECKOUT_IDENTITY_KEYS.every((key) => first?.[key] === second?.[key]);
}

export async function runRecoveryMatrix({ repoRoot = REPO_ROOT, expectedSourceSha, expectedCandidateSha, outputPath = null, now = Date.now(), checkoutIdentityReader = checkoutIdentity } = {}) {
	const readIdentity = typeof checkoutIdentityReader === 'function' ? checkoutIdentityReader : checkoutIdentity;
	const identity = failureIdentity(repoRoot, readIdentity);
	let identityValid = false;
	try {
		identityValid = validateCheckoutIdentity(identity, expectedSourceSha, expectedCandidateSha);
	} catch {
		identityValid = false;
	}
	const candidateSha = identity.source_sha;
	let inventory;
	try {
		inventory = await buildScopeInventory(repoRoot);
	} catch {
		inventory = { state: 'FAIL', repository_reference_count: 0, postgres_relation_groups: 0, hermes_state_areas: 0, live_backup_facts: 'BLOCKED', live_host_facts: 'BLOCKED', hydra_boundary: 'OUTSIDE_SCOPE' };
	}
	let syntheticRestore;
	try {
		syntheticRestore = await runSyntheticTenantRestoreDrill(candidateSha, { now });
	} catch {
		syntheticRestore = { state: 'FAIL', restored_file_count: 0, selected_scope_count: 0, excluded_scope_count: 0, private_modes: false, manifest_integrity: false, cross_scope_content: true, duration_ms: 0, backup_file_count: 0 };
	}
	let hermesOfflineChecks;
	try {
		hermesOfflineChecks = await buildHermesOfflineEvidence(repoRoot, candidateSha, now);
	} catch {
		hermesOfflineChecks = failedHermesOfflineChecks(now);
	}
	const finalIdentity = failureIdentity(repoRoot, readIdentity);
	let finalIdentityValid = false;
	try {
		finalIdentityValid = validateCheckoutIdentity(finalIdentity, expectedSourceSha, expectedCandidateSha);
	} catch {
		finalIdentityValid = false;
	}
	const identityStable = checkoutIdentitiesMatch(identity, finalIdentity);
	if (!identityStable && hermesOfflineChecks?.state === 'PASS' && hermesOfflineChecks.candidate_sha !== finalIdentity.source_sha) {
		hermesOfflineChecks = failedHermesOfflineChecks(now);
	}
	const record = buildReleaseRecord({ identity: finalIdentity, identityValid: identityValid && finalIdentityValid && identityStable, inventory, syntheticRestore, hermesOfflineChecks, now });
	const output = await writeReleaseRecord(outputPath ?? defaultOutputPath(repoRoot, candidateSha), record, { repoRoot });
	return { record, output, identityValid: identityValid && finalIdentityValid && identityStable };
}

const CLI_KEYS = new Set(['source_sha', 'candidate_sha', 'output']);

export function parseArgs(argv) {
	const result = {};
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') continue;
		if (argument === '--help') {
			result.help = true;
			continue;
		}
		const [rawKey, inlineValue] = argument.split('=', 2);
		const key = rawKey.startsWith('--') ? rawKey.slice(2).replaceAll('-', '_') : null;
		if (!key || !CLI_KEYS.has(key) || seen.has(key)) fail('argument_invalid');
		seen.add(key);
		const value = inlineValue ?? argv[index + 1];
		if (!value || (inlineValue === undefined && value.startsWith('--'))) fail('argument_value_missing');
		result[key] = value;
		if (inlineValue === undefined) index += 1;
	}
	return result;
}

function printUsage() {
	console.log('pnpm canary:jig184 -- --source-sha <full-sha> --candidate-sha <full-sha> [--output .tmp/jig-184/recovery.json]');
	console.log('No database, VPS, provider, service, or network authority is accepted by this local-only command.');
}

export async function main(argv = process.argv.slice(2)) {
	let args;
	try {
		args = parseArgs(argv);
	} catch {
		console.error(`${JIG184_TICKET}_RECOVERY argument_error`);
		return 1;
	}
	if (args.help) {
		printUsage();
		return 0;
	}
	try {
		const result = await runRecoveryMatrix({
			expectedSourceSha: args.source_sha,
			expectedCandidateSha: args.candidate_sha,
			outputPath: args.output ? resolve(REPO_ROOT, args.output) : null
		});
		console.log(`${JIG184_TICKET}_RECOVERY synthetic_restore=${result.record.synthetic_restore.state} postgres=${result.record.gates.find((item) => item.id === 'isolated_postgres_snapshot_restore')?.state} hermes_rebuild=${result.record.gates.find((item) => item.id === 'pinned_hermes_rebuild_start_readiness')?.state} release_decision=${result.record.release_decision} record_sha256=${result.output.sha256}`);
		console.log(`record_path=${relative(REPO_ROOT, result.output.path)}`);
		return releaseExitCode(result.record);
	} catch {
		console.error(`${JIG184_TICKET}_RECOVERY runner_failed release_decision=BLOCK_RELEASE`);
		return 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => process.exit(code)).catch(() => process.exit(1));
}
