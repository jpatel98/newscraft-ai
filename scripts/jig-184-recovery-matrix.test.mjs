import assert from 'node:assert/strict';
import { createHash as nodeCreateHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	JIG184_ALLOWED_BRANCHES,
	JIG184_BASE_SHA,
	JIG184_EVIDENCE_SCHEMA_VERSION,
	JIG184_TICKET,
	HERMES_REVIEWED_COMMIT,
	MAX_EVIDENCE_AGE_MS,
	REQUIRED_GATE_IDS,
	assertRedactedReleaseRecord,
	buildHermesOfflineEvidence,
	buildReleaseRecord,
	buildScopeInventory,
	createTenantManifest,
	releaseExitCode,
	restoreTenantBackup,
	runRecoveryMatrix,
	runSyntheticTenantRestoreDrill,
	parseArgs,
	validateReleaseRecord,
	validateCheckoutIdentity,
	validateHermesOfflineEvidence,
	validatePostgresRestoreEvidence,
	validateTenantManifest,
	writeReleaseRecord
} from './jig-184-recovery-matrix.mjs';

const CANDIDATE_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const NOW = Date.parse('2026-08-27T16:00:00.000Z');
const RECORDED_AT = new Date(NOW).toISOString();

function identity(branch = JIG184_ALLOWED_BRANCHES[0], sourceSha = CANDIDATE_SHA) {
	return {
		branch,
		source_sha: sourceSha,
		base_sha: JIG184_BASE_SHA,
		clean: true,
		base_present: true,
		commit_present: true,
		base_is_ancestor: true
	};
}

function postgresEvidence(overrides = {}) {
	return {
		schema_version: JIG184_EVIDENCE_SCHEMA_VERSION,
		ticket: JIG184_TICKET,
		candidate_sha: CANDIDATE_SHA,
		source_sha: CANDIDATE_SHA,
		captured_at: RECORDED_AT,
		execution: 'isolated-test-postgres-restore',
		scope: 'disposable-loopback-test-only',
		test_identity: 'dedicated-fixture-only',
		loopback: true,
		isolated: true,
		test_data_only: true,
		schema: { migration_revision_count: 3, schema_digest: 'a'.repeat(64) },
		rows: { table_count: 2, row_count: 4, aggregate_digest: 'b'.repeat(64) },
		isolation: { selected_scope_count: 1, foreign_scope_count: 0 },
		state: 'PASS',
		...overrides
	};
}

function manifestFiles(workspaceBytes = Buffer.from('{"fixture":"workspace"}\n'), browserBytes = Buffer.from('{"fixture":"browser"}\n')) {
	return [
		{ relative_path: 'workspace/state.json', kind: 'workspace', sha256: sha256(workspaceBytes), mode: 0o600 },
		{ relative_path: 'browser/state.json', kind: 'browser_state', sha256: sha256(browserBytes), mode: 0o600 }
	];
}

function sha256(value) {
	return nodeCreateHash('sha256').update(value).digest('hex');
}

function validManifest(overrides = {}) {
	return createTenantManifest({
		candidateSha: CANDIDATE_SHA,
		capturedAt: RECORDED_AT,
		files: manifestFiles(),
		...overrides
	});
}

async function makeBackup({ workspaceBytes = Buffer.from('{"fixture":"workspace"}\n'), browserBytes = Buffer.from('{"fixture":"browser"}\n'), manifestOverrides = {} } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'newscraft-jig184-test-'));
	await chmod(root, 0o700);
	const backupRoot = join(root, 'backup');
	await mkdir(backupRoot, { mode: 0o700 });
	await mkdir(join(backupRoot, 'workspace'), { mode: 0o700 });
	await mkdir(join(backupRoot, 'browser'), { mode: 0o700 });
	await writeFile(join(backupRoot, 'workspace/state.json'), workspaceBytes, { mode: 0o600 });
	await writeFile(join(backupRoot, 'browser/state.json'), browserBytes, { mode: 0o600 });
	await chmod(join(backupRoot, 'workspace'), 0o700);
	await chmod(join(backupRoot, 'browser'), 0o700);
	const manifest = createTenantManifest({
		candidateSha: CANDIDATE_SHA,
		capturedAt: RECORDED_AT,
		files: manifestFiles(workspaceBytes, browserBytes),
		...manifestOverrides
	});
	await writeFile(join(backupRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
	return { root, backupRoot, restoreRoot: join(root, 'restore'), manifest };
}

async function validReleaseRecord(branch = JIG184_ALLOWED_BRANCHES[0]) {
	const inventory = await buildScopeInventory(resolve('.'));
	const synthetic = await runSyntheticTenantRestoreDrill(CANDIDATE_SHA, { now: NOW });
	const hermes = await buildHermesOfflineEvidence(resolve('.'), CANDIDATE_SHA, NOW);
	return buildReleaseRecord({
		identity: identity(branch),
		identityValid: JIG184_ALLOWED_BRANCHES.includes(branch),
		inventory,
		syntheticRestore: synthetic,
		hermesOfflineChecks: hermes,
		now: NOW
	});
}

test('checkout identity accepts only the candidate branch or canonical main and keeps every guard', () => {
	assert.equal(validateCheckoutIdentity(identity('codex/jig-184-recovery'), CANDIDATE_SHA, CANDIDATE_SHA), true);
	assert.equal(validateCheckoutIdentity(identity('main'), CANDIDATE_SHA, CANDIDATE_SHA), true);
	assert.throws(() => validateCheckoutIdentity(identity('feature/unrelated'), CANDIDATE_SHA, CANDIDATE_SHA), /branch_not_authorized/);
	assert.throws(() => validateCheckoutIdentity({ ...identity(), clean: false }, CANDIDATE_SHA, CANDIDATE_SHA), /checkout_not_clean/);
	assert.throws(() => validateCheckoutIdentity({ ...identity(), base_is_ancestor: false }, CANDIDATE_SHA, CANDIDATE_SHA), /checkout_ancestry_invalid/);
	assert.throws(() => validateCheckoutIdentity(identity('main', OTHER_SHA), CANDIDATE_SHA, CANDIDATE_SHA), /candidate_does_not_match_clean_head/);
	assert.throws(() => validateCheckoutIdentity(identity(), CANDIDATE_SHA, OTHER_SHA), /source_and_candidate_revisions_must_match/);
});

test('Postgres restore evidence accepts only fresh isolated test aggregates', () => {
	assert.equal(validatePostgresRestoreEvidence(postgresEvidence(), { candidateSha: CANDIDATE_SHA, now: NOW }).state, 'PASS');
	assert.throws(() => validatePostgresRestoreEvidence(postgresEvidence({ captured_at: new Date(NOW - MAX_EVIDENCE_AGE_MS - 1).toISOString() }), { candidateSha: CANDIDATE_SHA, now: NOW }), /evidence_stale/);
	assert.throws(() => validatePostgresRestoreEvidence(postgresEvidence({ captured_at: 'not-a-time' }), { candidateSha: CANDIDATE_SHA, now: NOW }), /timestamp_invalid/);
	assert.throws(() => validatePostgresRestoreEvidence(postgresEvidence({ captured_at: new Date(NOW + 6 * 60 * 1000).toISOString() }), { candidateSha: CANDIDATE_SHA, now: NOW }), /timestamp_in_future/);
	assert.throws(() => validatePostgresRestoreEvidence(postgresEvidence({ candidate_sha: OTHER_SHA }), { candidateSha: CANDIDATE_SHA, now: NOW }), /postgres_restore_revision_mismatch/);
	assert.throws(() => validatePostgresRestoreEvidence(postgresEvidence({ isolation: { selected_scope_count: 1, foreign_scope_count: 1 } }), { candidateSha: CANDIDATE_SHA, now: NOW }), /postgres_restore_isolation_failed/);
});

test('synthetic tenant restore runs privately and excludes the other synthetic scope', async () => {
	const result = await runSyntheticTenantRestoreDrill(CANDIDATE_SHA, { now: NOW });
	assert.equal(result.state, 'PASS');
	assert.equal(result.restored_file_count, 2);
	assert.equal(result.selected_scope_count, 1);
	assert.equal(result.excluded_scope_count, 1);
	assert.equal(result.private_modes, true);
	assert.equal(result.manifest_integrity, true);
	assert.equal(result.cross_scope_content, false);
});

test('tenant manifest rejects traversal, absolute paths, duplicate files, stale data, and mismatched scope', () => {
	assert.throws(() => validateTenantManifest(validManifest({ files: [{ ...manifestFiles()[0], relative_path: '../outside' }, manifestFiles()[1] ] }), { candidateSha: CANDIDATE_SHA, now: NOW }), /relative_path_invalid/);
	assert.throws(() => validateTenantManifest(validManifest({ files: [{ ...manifestFiles()[0], relative_path: '/outside' }, manifestFiles()[1] ] }), { candidateSha: CANDIDATE_SHA, now: NOW }), /relative_path_invalid/);
	const duplicateFiles = manifestFiles();
	duplicateFiles[1] = { ...duplicateFiles[0] };
	assert.throws(() => validateTenantManifest(validManifest({ files: duplicateFiles, manifest_sha256: undefined }), { candidateSha: CANDIDATE_SHA, now: NOW }), /tenant_manifest_digest_invalid|tenant_manifest_duplicate_file/);
	const stale = createTenantManifest({ candidateSha: CANDIDATE_SHA, capturedAt: new Date(NOW - MAX_EVIDENCE_AGE_MS - 1).toISOString(), files: manifestFiles() });
	assert.throws(() => validateTenantManifest(stale, { candidateSha: CANDIDATE_SHA, now: NOW }), /evidence_stale/);
	assert.throws(() => validateTenantManifest(validManifest(), { candidateSha: CANDIDATE_SHA, expectedScope: 'synthetic-tenant-b', now: NOW }), /tenant_manifest_scope_mismatch/);
	const mismatchedRevision = createTenantManifest({ candidateSha: OTHER_SHA, capturedAt: RECORDED_AT, files: manifestFiles() });
	assert.throws(() => validateTenantManifest(mismatchedRevision, { candidateSha: CANDIDATE_SHA, now: NOW }), /tenant_manifest_revision_mismatch/);
});

test('tenant restore rejects symlink input, hardlink input, tampering, and secret-bearing artifacts', async () => {
	const cases = [];
	const symlinkCase = await makeBackup();
	const outside = await mkdtemp(join(tmpdir(), 'newscraft-jig184-outside-'));
	await chmod(outside, 0o700);
	await rm(join(symlinkCase.backupRoot, 'workspace'), { recursive: true, force: true });
	await symlink(outside, join(symlinkCase.backupRoot, 'workspace'));
	cases.push([symlinkCase, /symlink_path_component|backup_tree_symlink/]);

	const hardlinkCase = await makeBackup();
	const hardlinkOutside = join(hardlinkCase.root, 'outside.dat');
	await writeFile(hardlinkOutside, 'outside', { mode: 0o600 });
	await rm(join(hardlinkCase.backupRoot, 'workspace/state.json'));
	await link(hardlinkOutside, join(hardlinkCase.backupRoot, 'workspace/state.json'));
	cases.push([hardlinkCase, /backup_file_mode_or_link_invalid/]);

	const tamperedCase = await makeBackup();
	await writeFile(join(tamperedCase.backupRoot, 'workspace/state.json'), '{"fixture":"tampered"}\n', { mode: 0o600 });
	cases.push([tamperedCase, /tenant_backup_file_digest_invalid/]);

	const secretCase = await makeBackup({ workspaceBytes: Buffer.from('password=should-not-be-backed-up\n') });
	cases.push([secretCase, /secret_bearing_value/]);

	for (const [fixture, expected] of cases) {
		await assert.rejects(
			restoreTenantBackup({ backupRoot: fixture.backupRoot, restoreRoot: fixture.restoreRoot, candidateSha: CANDIDATE_SHA, now: NOW }),
			expected
		);
		await rm(fixture.root, { recursive: true, force: true });
	}
	await rm(outside, { recursive: true, force: true });
});

test('release-record output confinement rejects symlink parents and symlink files', async () => {
	const artifactRoot = resolve('.tmp/jig-184');
	await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
	await chmod(artifactRoot, 0o700);
	const outside = await mkdtemp(join(tmpdir(), 'newscraft-jig184-record-outside-'));
	await chmod(outside, 0o700);
	const sentinel = join(outside, 'sentinel.json');
	await writeFile(sentinel, 'sentinel\n', { mode: 0o600 });
	const parentName = `symlink-parent-${process.pid}-${Date.now()}`;
	const parent = join(artifactRoot, parentName);
	await symlink(outside, parent);
	const record = await validReleaseRecord();
	await assert.rejects(writeReleaseRecord(join(parent, 'record.json'), record), /artifact_path_symlink|symlink_path_component/);
	await rm(parent, { force: true });
	const output = join(artifactRoot, `symlink-file-${process.pid}-${Date.now()}.json`);
	await symlink(sentinel, output);
	await assert.rejects(writeReleaseRecord(output, record), /artifact_path_symlink|symlink_path_component/);
	assert.equal(await readFile(sentinel, 'utf8'), 'sentinel\n');
	await rm(output, { force: true });
	const hardlinkOutput = join(artifactRoot, `hardlink-file-${process.pid}-${Date.now()}.json`);
	await link(sentinel, hardlinkOutput);
	await assert.rejects(writeReleaseRecord(hardlinkOutput, record), /output_hardlink/);
	assert.equal(await readFile(sentinel, 'utf8'), 'sentinel\n');
	await rm(hardlinkOutput, { force: true });
	await rm(outside, { recursive: true, force: true });
});

test('Hermes offline evidence binds the pinned source and lock aggregate without private values', async () => {
	const evidence = await buildHermesOfflineEvidence(resolve('.'), CANDIDATE_SHA, NOW);
	assert.equal(evidence.state, 'PASS');
	assert.equal(evidence.source_commit, HERMES_REVIEWED_COMMIT);
	assert.equal(evidence.private_settings_shape.supplied_value_count, 0);
	assert.equal(evidence.private_settings_shape.values_recorded, false);
	assert.throws(() => validateHermesOfflineEvidence({ ...evidence, source_commit: OTHER_SHA }, { candidateSha: CANDIDATE_SHA, now: NOW }), /hermes_offline_identity_invalid/);
});

test('release exit is fail-closed for missing, duplicate, unknown, and blocked required gates', async () => {
	const inventory = await buildScopeInventory(resolve('.'));
	const synthetic = await runSyntheticTenantRestoreDrill(CANDIDATE_SHA, { now: NOW });
	const hermes = await buildHermesOfflineEvidence(resolve('.'), CANDIDATE_SHA, NOW);
	const base = buildReleaseRecord({ identity: identity(), identityValid: true, inventory, syntheticRestore: synthetic, hermesOfflineChecks: hermes, now: NOW });
	assert.equal(base.release_decision, 'BLOCK RELEASE');
	assert.equal(releaseExitCode(base), 1);
	for (const gates of [
		base.gates.slice(0, -1),
		[...base.gates, { ...base.gates[0] }],
		base.gates.map((gate, index) => index === 0 ? { ...gate, id: 'unknown_gate' } : gate),
		base.gates.map((gate, index) => index === 0 ? { ...gate, state: 'PASS' } : gate)
	]) {
		assert.equal(releaseExitCode({ ...base, release_decision: 'RELEASE', release_exit_code: 0, gates }), 1);
	}
	assert.deepEqual(base.required_gate_ids, [...REQUIRED_GATE_IDS]);
});

test('release record uses an exact allowlist and rejects raw paths, SQL, Bearer text, and nested extras', async () => {
	const record = await validReleaseRecord('main');
	assert.equal(validateReleaseRecord(record), true);
	assert.equal(record.hermes_offline_checks.installer_reference.offline_checked, true);
	assert.equal(record.hermes_offline_checks.deployment_reference.unit_examples_present, true);
	for (const value of ['/private/prod/snapshot.sql', 'SELECT * FROM accounts', 'Bearer super-secret-value']) {
		assert.throws(() => assertRedactedReleaseRecord({ ...record, extra: value }), /release_record_schema_invalid/);
		assert.throws(() => assertRedactedReleaseRecord({ ...record, limitations: [value, ...record.limitations.slice(1)] }), /release_limitations_invalid/);
	}
	assert.throws(() => assertRedactedReleaseRecord({ ...record, checkout: { ...record.checkout, extra: true } }), /release_checkout_schema_invalid/);
	assert.throws(() => assertRedactedReleaseRecord({ ...record, gates: record.gates.map((gate, index) => index === 0 ? { ...gate, extra: true } : gate) }), /release_gate_0_schema_invalid/);
	assert.throws(() => assertRedactedReleaseRecord({ ...record, hermes_offline_checks: { ...record.hermes_offline_checks, private_settings_shape: { ...record.hermes_offline_checks.private_settings_shape, extra: true } } }), /release_hermes_private_settings_shape_schema_invalid/);
	assert.equal(releaseExitCode(record), 1);
	const outputPath = `.tmp/jig-184/redaction-${process.pid}-${Date.now()}.json`;
	await assert.rejects(writeReleaseRecord(resolve('.', outputPath), { ...record, extra: 'token=should-not-be-written' }), /release_record_schema_invalid/);
});

test('release PASS gates remain bound to truthful checkout and inventory evidence at validation and write time', async () => {
	const record = await validReleaseRecord();
	const mutations = [
		[
			{ ...record, checkout: { ...record.checkout, branch: 'feature/unrelated' } },
			/release_checkout_branch_invalid/
		],
		[
			{ ...record, checkout: { ...record.checkout, clean: false } },
			/release_checkout_gate_mismatch/
		],
		[
			{ ...record, checkout: { ...record.checkout, commit_present: false } },
			/release_checkout_gate_mismatch/
		],
		[
			{ ...record, inventory: { ...record.inventory, repository_reference_count: 0, postgres_relation_groups: 0, hermes_state_areas: 0 } },
			/release_inventory_pass_evidence_invalid/
		]
	];

	for (const [index, [mutated, expected]] of mutations.entries()) {
		assert.throws(() => validateReleaseRecord(mutated), expected);
		assert.equal(releaseExitCode(mutated), 1);
		const outputPath = resolve('.', `.tmp/jig-184/rejected-binding-${process.pid}-${Date.now()}-${index}.json`);
		await assert.rejects(writeReleaseRecord(outputPath, mutated), expected);
	}

	const unauthorized = buildReleaseRecord({
		identity: identity('feature/unrelated'),
		identityValid: false,
		inventory: record.inventory,
		syntheticRestore: record.synthetic_restore,
		hermesOfflineChecks: record.hermes_offline_checks,
		now: NOW
	});
	assert.equal(unauthorized.checkout.branch, null);
	assert.equal(unauthorized.gates[0].state, 'FAIL');
	assert.equal(validateReleaseRecord(unauthorized), true);
	assert.equal(unauthorized.release_decision, 'BLOCK RELEASE');
	assert.equal(releaseExitCode(unauthorized), 1);

	assert.equal(record.checkout.branch, 'codex/jig-184-recovery');
	const mainRecord = await validReleaseRecord('main');
	assert.equal(mainRecord.checkout.branch, 'main');
	assert.equal(validateReleaseRecord(mainRecord), true);
	assert.equal(releaseExitCode(mainRecord), 1);
});

test('release policy is explicitly local block-only and nested Hermes evidence is validated', async () => {
	const record = await validReleaseRecord();
	assert.equal(validateReleaseRecord(record), true);
	assert.equal(releaseExitCode(record), 1);
	const allPassGates = record.gates.map(({ reason, ...gate }) => ({ ...gate, state: 'PASS' }));
	const forged = { ...record, gates: allPassGates, release_decision: 'RELEASE', release_exit_code: 0 };
	assert.throws(() => validateReleaseRecord(forged), /release_gate_external_pass_forbidden/);
	assert.equal(releaseExitCode(forged), 1);
	assert.throws(() => validateReleaseRecord({ ...record, release_decision: 'RELEASE' }), /release_policy_block_only/);
	assert.throws(() => validateReleaseRecord({ ...record, release_exit_code: 0 }), /release_policy_block_only/);
});

test('checkout identity drift between the initial and final read fails the checkout gate', async () => {
	const driftFields = [
		['branch', 'main'],
		['source_sha', OTHER_SHA],
		['base_sha', OTHER_SHA],
		['clean', false],
		['base_present', false],
		['commit_present', false],
		['base_is_ancestor', false]
	];
	for (const [field, value] of driftFields) {
		let reads = 0;
		const outputPath = resolve('.', `.tmp/jig-184/drift-${field}-${process.pid}-${Date.now()}.json`);
		const result = await runRecoveryMatrix({
			repoRoot: resolve('.'),
			expectedSourceSha: CANDIDATE_SHA,
			expectedCandidateSha: CANDIDATE_SHA,
			outputPath,
			now: NOW,
			checkoutIdentityReader: () => {
				reads += 1;
				return reads === 1 ? identity() : { ...identity(), [field]: value };
				}
		});
		assert.equal(reads, 2);
		assert.equal(result.identityValid, false);
		assert.equal(result.record.checkout[field], field === 'base_sha' ? null : value);
		assert.equal(result.record.gates[0].state, 'FAIL');
		assert.equal(result.record.release_decision, 'BLOCK RELEASE');
		assert.equal(releaseExitCode(result.record), 1);
		await rm(result.output.path, { force: true });
	}
});

test('public command arguments are explicit and the local command records a blocked release without a database', async () => {
	assert.deepEqual(parseArgs(['--source-sha', CANDIDATE_SHA, '--candidate-sha', CANDIDATE_SHA]), { source_sha: CANDIDATE_SHA, candidate_sha: CANDIDATE_SHA });
	assert.deepEqual(parseArgs(['--', '--source-sha', CANDIDATE_SHA, '--candidate-sha', CANDIDATE_SHA]), { source_sha: CANDIDATE_SHA, candidate_sha: CANDIDATE_SHA });
	assert.throws(() => parseArgs(['--source-sha', CANDIDATE_SHA, '--source-sha', CANDIDATE_SHA]), /argument_invalid/);
	const outputPath = `.tmp/jig-184/test-public-${process.pid}-${Date.now()}.json`;
	const result = await runRecoveryMatrix({
		repoRoot: resolve('.'),
		expectedSourceSha: CANDIDATE_SHA,
		expectedCandidateSha: CANDIDATE_SHA,
		outputPath: resolve('.', outputPath),
		now: NOW
	});
	assert.equal(result.record.release_decision, 'BLOCK RELEASE');
	assert.equal(result.record.release_exit_code, 1);
	assert.equal(releaseExitCode(result.record), 1);
	const outputStats = lstatSync(result.output.path);
	assert.equal(outputStats.mode & 0o777, 0o600);
	await rm(result.output.path, { force: true });
});
