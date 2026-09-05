import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	JIG181_BASE_SHA,
	JIG181_CASES,
	JIG181_EVIDENCE_SCHEMA_VERSION,
	JIG181_LAYOUT_SHIFT_THRESHOLD,
	JIG181_MAX_AUTHORITY_LIFETIME_MS,
	JIG181_REQUIRED_DEVICE,
	JIG181_SETTLING_WINDOW_MS,
	assertSafeArtifactPath,
	buildPlaywrightCommand,
	buildPlaywrightEnvironment,
	buildReleaseRecord,
	checkoutIdentity,
	loadLocalEvidenceManifest,
	parseArgs,
	parseAuthority,
	releaseExitCode,
	assertRedactedReleaseRecord,
	validateCheckoutIdentity,
	validateLocalEvidenceManifest,
	validatePhysicalDeviceEvidence,
	writeReleaseRecord
} from './jig-181-ui-matrix.mjs';
import { duplicateDurableStartCount, isSettlingCase } from './jig-181-ui-matrix-contract.mjs';

const CANDIDATE_SHA = '0123456789abcdef0123456789abcdef01234567';
const NOW = Date.parse('2026-08-27T16:00:00.000Z');
const RECORDED_AT = new Date(NOW).toISOString();

function localManifest(candidateSha = CANDIDATE_SHA) {
	return {
		schema_version: JIG181_EVIDENCE_SCHEMA_VERSION,
		ticket: 'JIG-181',
		candidate_sha: candidateSha,
		captured_at: RECORDED_AT,
		browser: { name: 'chromium', version: 'chromium-140.0.0' },
		cases: JIG181_CASES.map((caseSpec) => ({
			case_id: caseSpec.id,
			state: 'PASS',
			browser_project: `jig181-${caseSpec.viewport}`,
			browser_name: 'chromium',
			browser_version: 'chromium-140.0.0',
			viewport: caseSpec.viewport,
			screenshot_id: `shot-${caseSpec.id}`,
			trace_id: null,
			console_error_count: 0,
			page_error_count: 0,
			failed_request_count: 0,
			layout_shift: 0,
			transition_layout_shift: isSettlingCase(caseSpec.id) ? 0.2 : null,
			settling_window_ms: isSettlingCase(caseSpec.id) ? JIG181_SETTLING_WINDOW_MS : null,
			duplicate_request_count: 0,
			recorded_at: RECORDED_AT
		}))
	};
}

function authority(expiresAt) {
	return {
		schema_version: 1,
		scope: 'disposable-local',
		candidate_sha: CANDIDATE_SHA,
		database_name: 'newscraft_e2e_jig181_local',
		loopback: true,
		allows_test_mutation: true,
		expires_at: expiresAt
	};
}

function deviceEvidence(candidateSha = CANDIDATE_SHA) {
	return {
		schema_version: JIG181_EVIDENCE_SCHEMA_VERSION,
		ticket: 'JIG-181',
		candidate_sha: candidateSha,
		captured_at: RECORDED_AT,
		execution: 'physical_device',
		emulation: false,
		device_name: JIG181_REQUIRED_DEVICE.name,
		os_version: 'iOS 18',
		browser_name: JIG181_REQUIRED_DEVICE.browser,
		browser_version: 'Safari 18',
		evidence_id: 'iphone-evidence-1',
		screenshot_id: 'iphone-shot-1',
		trace_id: null,
		console_error_count: 0,
		page_error_count: 0,
		failed_request_count: 0,
		layout_shift: 0,
		duplicate_request_count: 0,
		state: 'PASS'
	};
}

function identity(branch = 'codex/jig-181-ui-matrix', sourceSha = CANDIDATE_SHA) {
	return {
		branch,
		source_sha: sourceSha,
		base_sha: JIG181_BASE_SHA,
		clean: true,
		base_present: true,
		commit_present: true,
		base_is_ancestor: true
	};
}

function acceptedRecord(branch = 'codex/jig-181-ui-matrix') {
	const checkout = identity(branch);
	const local = validateLocalEvidenceManifest(localManifest(), CANDIDATE_SHA, NOW);
	const device = validatePhysicalDeviceEvidence(deviceEvidence(), CANDIDATE_SHA, NOW);
	return buildReleaseRecord({
		identity: checkout,
		identityValid: true,
		localEvidence: local,
		deviceEvidence: device,
		browserExecution: { requested: false, state: 'BLOCKED', reason: 'browser_execution_not_requested', exit_code: null },
		now: NOW
	});
}

function recordWithBrowserExecution(browserExecution) {
	const checkout = identity();
	const local = validateLocalEvidenceManifest(localManifest(), CANDIDATE_SHA, NOW);
	const device = validatePhysicalDeviceEvidence(deviceEvidence(), CANDIDATE_SHA, NOW);
	return buildReleaseRecord({
		identity: checkout,
		identityValid: true,
		localEvidence: local,
		deviceEvidence: device,
		browserExecution,
		now: NOW
	});
}

test('accepts only the candidate branch or canonical main with all checkout guards', () => {
	assert.equal(validateCheckoutIdentity(identity('codex/jig-181-ui-matrix'), CANDIDATE_SHA, CANDIDATE_SHA), true);
	assert.equal(validateCheckoutIdentity(identity('main'), CANDIDATE_SHA, CANDIDATE_SHA), true);
	assert.throws(
		() => validateCheckoutIdentity(identity('feature/not-a-release'), CANDIDATE_SHA, CANDIDATE_SHA),
		/branch_not_authorized/
	);
	assert.throws(
		() => validateCheckoutIdentity({ ...identity(), clean: false }, CANDIDATE_SHA, CANDIDATE_SHA),
		/checkout_not_clean/
	);
	assert.throws(
		() => validateCheckoutIdentity(identity(), CANDIDATE_SHA, 'fedcba9876543210fedcba9876543210fedcba98'),
		/source_and_candidate_revisions_must_match/
	);
	assert.throws(
		() => validateCheckoutIdentity({ ...identity(), base_is_ancestor: false }, CANDIDATE_SHA, CANDIDATE_SHA),
		/base_ancestry_invalid/
	);
});

test('rejects incomplete, duplicate, unknown, stale, and mismatched browser evidence', () => {
	const valid = localManifest();
	assert.equal(validateLocalEvidenceManifest(valid, CANDIDATE_SHA, NOW).accepted, true);

	const missing = { ...valid, cases: valid.cases.slice(0, -1) };
	assert.throws(() => validateLocalEvidenceManifest(missing, CANDIDATE_SHA, NOW), /evidence_missing_case/);

	const duplicate = { ...valid, cases: [...valid.cases, { ...valid.cases[0] }] };
	assert.throws(() => validateLocalEvidenceManifest(duplicate, CANDIDATE_SHA, NOW), /evidence_duplicate_case/);

	const unknown = {
		...valid,
		cases: valid.cases.map((item, index) => (index === 0 ? { ...item, case_id: 'not_a_required_case' } : item))
	};
	assert.throws(() => validateLocalEvidenceManifest(unknown, CANDIDATE_SHA, NOW), /evidence_unknown_case/);

	const thresholdFailure = {
		...valid,
		cases: valid.cases.map((item, index) => (index === 0 ? { ...item, duplicate_request_count: 1 } : item))
	};
	const failed = validateLocalEvidenceManifest(thresholdFailure, CANDIDATE_SHA, NOW);
	assert.equal(failed.accepted, false);
	assert.equal(failed.case_counts.fail, 1);

	const stale = { ...valid, captured_at: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() };
	assert.throws(() => validateLocalEvidenceManifest(stale, CANDIDATE_SHA, NOW), /evidence_stale/);
	assert.throws(() => validateLocalEvidenceManifest(valid, 'fedcba9876543210fedcba9876543210fedcba98', NOW), /evidence_candidate_mismatch/);

	const mismatchedProject = {
		...valid,
		cases: valid.cases.map((item, index) => (index === 0 ? { ...item, browser_project: 'jig181-wrong-project' } : item))
	};
	assert.throws(() => validateLocalEvidenceManifest(mismatchedProject, CANDIDATE_SHA, NOW), /evidence_browser_project_mismatch/);
});

test('keeps transition CLS diagnostic while gating the bounded settling metric', () => {
	const valid = localManifest();
	const transitionCases = valid.cases.filter((item) => isSettlingCase(item.case_id));
	assert.equal(transitionCases.length, 2);
	assert.ok(transitionCases.every((item) => item.transition_layout_shift > JIG181_LAYOUT_SHIFT_THRESHOLD));
	assert.equal(validateLocalEvidenceManifest(valid, CANDIDATE_SHA, NOW).accepted, true);

	const autonomousShift = {
		...valid,
		cases: valid.cases.map((item) =>
			item.case_id === 'keyboard_open_close'
				? { ...item, layout_shift: JIG181_LAYOUT_SHIFT_THRESHOLD + 0.001 }
				: item
		)
	};
	const rejected = validateLocalEvidenceManifest(autonomousShift, CANDIDATE_SHA, NOW);
	assert.equal(rejected.accepted, false);
	assert.equal(rejected.case_counts.fail, 1);
});

test('database authority requires a bounded future expiry', () => {
	const oneHour = new Date(NOW + 60 * 60 * 1000).toISOString();
	assert.equal(parseAuthority(authority(oneHour), CANDIDATE_SHA, NOW).expires_at, oneHour);
	const maximum = new Date(NOW + JIG181_MAX_AUTHORITY_LIFETIME_MS).toISOString();
	assert.equal(parseAuthority(authority(maximum), CANDIDATE_SHA, NOW).expires_at, maximum);
	assert.throws(
		() => parseAuthority(authority(new Date(NOW - 1).toISOString()), CANDIDATE_SHA, NOW),
		/database_authority_expired/
	);
	assert.throws(() => parseAuthority(authority('not-a-timestamp'), CANDIDATE_SHA, NOW), /database_authority_expiry_invalid/);
	assert.throws(
		() => parseAuthority(authority(new Date(NOW + JIG181_MAX_AUTHORITY_LIFETIME_MS + 1).toISOString()), CANDIDATE_SHA, NOW),
		/database_authority_expiry_too_far/
	);
});

test('requires a real named iPhone evidence record and exact candidate binding', () => {
	const valid = validatePhysicalDeviceEvidence(deviceEvidence(), CANDIDATE_SHA, NOW);
	assert.equal(valid.state, 'PASS');
	assert.equal(validatePhysicalDeviceEvidence({ ...deviceEvidence(), emulation: true }, CANDIDATE_SHA, NOW).state, 'BLOCKED');
	assert.equal(validatePhysicalDeviceEvidence({ ...deviceEvidence(), device_name: 'iPhone 15' }, CANDIDATE_SHA, NOW).state, 'BLOCKED');
	assert.equal(validatePhysicalDeviceEvidence(deviceEvidence('fedcba9876543210fedcba9876543210fedcba98'), CANDIDATE_SHA, NOW).state, 'BLOCKED');
});

test('the public command is locked to the dedicated Playwright matrix config', () => {
	assert.deepEqual(buildPlaywrightCommand(), [
		'exec',
		'playwright',
		'test',
		'--config=playwright.jig181.config.ts'
	]);
	assert.deepEqual(parseArgs(['--run-browser']), { run_browser: true });
	assert.throws(() => parseArgs(['--run-browser', '--run-browser']), /unknown_argument/);
});

test('duplicate durable starts are derived from observed request counts', () => {
	assert.equal(duplicateDurableStartCount(1, 1), 0);
	assert.equal(duplicateDurableStartCount(3, 1), 2);
	assert.equal(duplicateDurableStartCount(2, 3), 0);
	assert.throws(() => duplicateDurableStartCount(-1, 1), /durable_start_count_invalid/);
	assert.throws(() => duplicateDurableStartCount(1, 1.5), /durable_start_count_invalid/);
});

test('Playwright child environment is explicit and excludes unrelated credentials', () => {
	const environment = buildPlaywrightEnvironment({
		candidateSha: CANDIDATE_SHA,
		authority: authority(new Date(NOW + 60 * 60 * 1000).toISOString()),
		evidencePath: '.tmp/jig-181/browser/evidence.json',
		evidenceDir: '.tmp/jig-181/browser',
		databaseUrl: 'postgresql://127.0.0.1/newscraft_e2e_jig181_local',
		sourceEnvironment: {
			PATH: '/local/bin',
			TMPDIR: '/local/tmp',
			HOME: '/local/home',
			OPENAI_API_KEY: 'sentinel-openai',
			SUPABASE_SERVICE_ROLE_KEY: 'sentinel-supabase',
			VERCEL_TOKEN: 'sentinel-vercel',
			DATABASE_URL: 'sentinel-database',
			JIG181_E2E_DATABASE_URL: 'sentinel-jig181-database'
		}
	});
	assert.equal(environment.PATH, '/local/bin');
	assert.equal(environment.TMPDIR, '/local/tmp');
	assert.equal(environment.HOME, '/local/home');
	assert.equal(environment.DATABASE_URL, 'postgresql://127.0.0.1/newscraft_e2e_jig181_local');
	assert.equal(environment.JIG181_E2E_DATABASE_URL, 'postgresql://127.0.0.1/newscraft_e2e_jig181_local');
	for (const key of ['OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'VERCEL_TOKEN']) {
		assert.equal(environment[key], undefined, `${key} must not reach the child`);
	}
});

test('releaseExitCode fails closed for missing, duplicate, unknown, failed, and forged gates', () => {
	const valid = acceptedRecord();
	assert.equal(releaseExitCode(valid), 0);

	assert.equal(releaseExitCode({ ...valid, gates: valid.gates.slice(0, -1) }), 1);
	assert.equal(releaseExitCode({ ...valid, gates: [...valid.gates, { ...valid.gates[0] }] }), 1);
	assert.equal(
		releaseExitCode({ ...valid, gates: valid.gates.map((gate, index) => (index === 0 ? { ...gate, id: 'unknown_gate' } : gate)) }),
		1
	);
	assert.equal(
		releaseExitCode({ ...valid, gates: valid.gates.map((gate, index) => (index === 0 ? { ...gate, state: 'BLOCKED' } : gate)) }),
		1
	);
	assert.equal(releaseExitCode({ ...valid, release_decision: 'RELEASE', checkout: { ...valid.checkout, clean: false } }), 1);
	assert.equal(releaseExitCode({ ...valid, release_decision: 'RELEASE', candidate: { ...valid.candidate, source_sha: 'fedcba9876543210fedcba9876543210fedcba98' } }), 1);
	assert.equal(
		releaseExitCode({
			...valid,
			browser_execution: {
				requested: true,
				state: 'FAIL',
				reason: 'playwright_matrix_failed',
				playwright_exit_code: 1
			}
		}),
		1
	);
	assert.equal(
		releaseExitCode({
			...valid,
			browser_execution: {
				requested: true,
				state: 'BLOCKED',
				reason: 'isolated_disposable_database_authority_missing',
				playwright_exit_code: null
			}
		}),
		1
	);
});

test('buildReleaseRecord binds the serialized decision to requested browser execution', () => {
	const requestedPass = recordWithBrowserExecution({ requested: true, state: 'PASS', reason: null, exit_code: 0 });
	assert.equal(requestedPass.release_decision, 'RELEASE');
	assert.equal(releaseExitCode(requestedPass), 0);

	const requestedFailure = recordWithBrowserExecution({
		requested: true,
		state: 'FAIL',
		reason: 'playwright_matrix_failed',
		exit_code: 1
	});
	assert.equal(requestedFailure.release_decision, 'BLOCK RELEASE');
	assert.equal(releaseExitCode(requestedFailure), 1);

	const requestedBlocked = recordWithBrowserExecution({
		requested: true,
		state: 'BLOCKED',
		reason: 'isolated_disposable_database_authority_missing',
		exit_code: null
	});
	assert.equal(requestedBlocked.release_decision, 'BLOCK RELEASE');
	assert.equal(releaseExitCode(requestedBlocked), 1);

	const suppliedEvidence = acceptedRecord();
	assert.equal(suppliedEvidence.browser_execution.requested, false);
	assert.equal(suppliedEvidence.release_decision, 'RELEASE');
	assert.equal(releaseExitCode(suppliedEvidence), 0);
});

test('release records are redacted aggregates and reject forbidden fields', () => {
	const valid = acceptedRecord('main');
	assert.equal(assertRedactedReleaseRecord(valid), true);
	assert.throws(() => assertRedactedReleaseRecord({ ...valid, prompt: 'private prompt' }), /forbidden_key/);
	assert.throws(() => assertRedactedReleaseRecord({ ...valid, extra: 'postgresql://127.0.0.1/private' }), /forbidden_value/);
});

test('invalid evidence input uses fixed redacted reasons', async () => {
	const invalid = await loadLocalEvidenceManifest(
		'.tmp/jig-181/missing-password-record.json',
		CANDIDATE_SHA,
		NOW
	);
	assert.equal(invalid.reason, 'browser_evidence_invalid_or_missing');
	assert.ok(invalid.cases.every((item) => item.reason === 'browser_evidence_invalid_or_missing'));
});

test('checkoutIdentity reads the actual current checkout rather than caller-supplied identity', () => {
	const actual = checkoutIdentity();
	assert.equal(actual.base_sha, JIG181_BASE_SHA);
	assert.equal(actual.source_sha.length, 40);
	assert.equal(typeof actual.clean, 'boolean');
	assert.equal(actual.commit_present, true);
});

test('artifact reads and writes reject symlink escapes and keep private modes', async () => {
	const artifactRoot = resolve('.tmp/jig-181', `confinement-${process.pid}-${Date.now()}`);
	const outsideRoot = await mkdtemp(join(tmpdir(), 'jig181-outside-'));
	try {
		await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
		const outsideFile = join(outsideRoot, 'outside.json');
		await writeFile(outsideFile, '{}', { encoding: 'utf8', mode: 0o600 });
		const escapingParent = join(artifactRoot, 'escaping-parent');
		await symlink(outsideRoot, escapingParent, 'dir');
		assert.throws(
			() => assertSafeArtifactPath(join(escapingParent, 'evidence.json')),
			/artifact_path_symlink/
		);

		const linkedInput = join(artifactRoot, 'linked-input.json');
		await symlink(outsideFile, linkedInput, 'file');
		const invalid = await loadLocalEvidenceManifest(linkedInput, CANDIDATE_SHA, NOW);
		assert.equal(invalid.reason, 'browser_evidence_invalid_or_missing');

		const symlinkOutput = join(artifactRoot, 'symlink-output.json');
		await symlink(outsideFile, symlinkOutput, 'file');
		await assert.rejects(
			() => writeReleaseRecord(symlinkOutput, acceptedRecord()),
			/artifact_path_symlink/
		);

		const result = await writeReleaseRecord(join(artifactRoot, 'nested', 'record.json'), acceptedRecord());
		assert.equal((await stat(result.path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(artifactRoot, 'nested'))).mode & 0o777, 0o700);
	} finally {
		await rm(artifactRoot, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	}
});
