#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	JIG181_BASE_SHA,
	JIG181_CASES,
	JIG181_DUPLICATE_REQUEST_THRESHOLD,
	JIG181_EVIDENCE_SCHEMA_VERSION,
	JIG181_EXPECTED_BRANCHES,
	JIG181_LAYOUT_SHIFT_THRESHOLD,
	JIG181_MAX_AUTHORITY_LIFETIME_MS,
	JIG181_MAX_EVIDENCE_AGE_MS,
	JIG181_REQUIRED_DEVICE,
	JIG181_REQUIRED_GATE_IDS,
	JIG181_TICKET,
	JIG181_VIEWPORTS,
	caseById,
	duplicateDurableStartCount,
	viewportById
} from './jig-181-ui-matrix-contract.mjs';

export {
	JIG181_BASE_SHA,
	JIG181_CASES,
	JIG181_EXPECTED_BRANCHES,
	JIG181_REQUIRED_DEVICE,
	JIG181_REQUIRED_GATE_IDS,
	JIG181_MAX_AUTHORITY_LIFETIME_MS,
	JIG181_VIEWPORTS,
	duplicateDurableStartCount
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ARTIFACT_ROOT = resolve(REPO_ROOT, '.tmp/jig-181');
const SHA_RE = /^[0-9a-f]{40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+()/:-]{0,63}$/;
const SAFE_DB_NAME_RE = /^newscraft_e2e_[a-z0-9_]{1,40}$/;
const ALLOWED_GATE_STATES = new Set(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED']);
const PLAYWRIGHT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'COREPACK_HOME']);
const CLI_VALUE_KEYS = new Set([
	'source_sha',
	'candidate_sha',
	'output',
	'evidence_manifest',
	'device_evidence',
	'database_authority'
]);

const EVIDENCE_CASE_KEYS = new Set([
	'case_id',
	'state',
	'browser_project',
	'browser_name',
	'browser_version',
	'viewport',
	'screenshot_id',
	'trace_id',
	'console_error_count',
	'page_error_count',
	'failed_request_count',
	'layout_shift',
	'duplicate_request_count',
	'recorded_at'
]);

const EVIDENCE_TOP_LEVEL_KEYS = new Set([
	'schema_version',
	'ticket',
	'candidate_sha',
	'captured_at',
	'browser',
	'cases'
]);

const EVIDENCE_BROWSER_KEYS = new Set(['name', 'version']);

const DEVICE_EVIDENCE_KEYS = new Set([
	'schema_version',
	'ticket',
	'candidate_sha',
	'captured_at',
	'execution',
	'emulation',
	'device_name',
	'os_version',
	'browser_name',
	'browser_version',
	'evidence_id',
	'screenshot_id',
	'trace_id',
	'console_error_count',
	'page_error_count',
	'failed_request_count',
	'layout_shift',
	'duplicate_request_count',
	'state'
]);

const AUTHORITY_KEYS = new Set([
	'schema_version',
	'scope',
	'candidate_sha',
	'database_name',
	'loopback',
	'allows_test_mutation',
	'expires_at'
]);

const FORBIDDEN_RECORD_KEY_RE = /(?:password|token|cookie|secret|prompt|answer|tenant|account|database|credential|authorization|environment|raw|url|path)/i;
const FORBIDDEN_RECORD_VALUE_RE = /(?:https?:\/\/|postgres(?:ql)?:|password|token=|secret|credential|authorization:|cookie:)/i;

function objectValue(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function assertExactKeys(value, allowed, label) {
	const object = objectValue(value);
	if (!object) throw new Error(`${label}_must_be_object`);
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) throw new Error(`${label}_unknown_field`);
	}
}

function isSafeId(value) {
	return typeof value === 'string' && SAFE_ID_RE.test(value);
}

function isSafeVersion(value) {
	return typeof value === 'string' && SAFE_VERSION_RE.test(value);
}

function isSha(value) {
	return typeof value === 'string' && SHA_RE.test(value);
}

function isFiniteNonNegative(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value) {
	return Number.isInteger(value) && value >= 0;
}

function parseTimestamp(value, now) {
	if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
		return { ok: false, reason: 'timestamp_invalid' };
	}
	const timestamp = Date.parse(value);
	if (timestamp > now + 5 * 60 * 1000) return { ok: false, reason: 'timestamp_in_future' };
	if (now - timestamp > JIG181_MAX_EVIDENCE_AGE_MS) return { ok: false, reason: 'evidence_stale' };
	return { ok: true, timestamp };
}

function safeEvidenceIdentifier(value) {
	return value === null || value === undefined || isSafeId(value) ? value ?? null : null;
}

function runGit(repoRoot, ...args) {
	const result = spawnSync('git', args, {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore']
	});
	if (result.status !== 0) throw new Error('git_command_failed');
	return String(result.stdout ?? '').trim();
}

function gitSucceeds(repoRoot, ...args) {
	return spawnSync('git', args, {
		cwd: repoRoot,
		stdio: ['ignore', 'ignore', 'ignore']
	}).status === 0;
}

export function checkoutIdentity(repoRoot = REPO_ROOT) {
	const sourceSha = runGit(repoRoot, 'rev-parse', 'HEAD');
	const status = runGit(repoRoot, 'status', '--porcelain=v1', '--untracked-files=all');
	const basePresent = gitSucceeds(repoRoot, 'cat-file', '-e', `${JIG181_BASE_SHA}^{commit}`);
	const commitPresent = isSha(sourceSha) && gitSucceeds(repoRoot, 'cat-file', '-e', `${sourceSha}^{commit}`);
	const baseIsAncestor = basePresent && commitPresent
		? gitSucceeds(repoRoot, 'merge-base', '--is-ancestor', JIG181_BASE_SHA, sourceSha)
		: false;
	return {
		branch: runGit(repoRoot, 'branch', '--show-current'),
		source_sha: sourceSha,
		base_sha: JIG181_BASE_SHA,
		clean: status.length === 0,
		base_present: basePresent,
		commit_present: commitPresent,
		base_is_ancestor: baseIsAncestor
	};
}

export function validateCheckoutIdentity(identity, expectedSourceSha, expectedCandidateSha, actual = identity) {
	if (!objectValue(identity) || !objectValue(actual)) throw new Error('checkout_identity_missing');
	if (!isSha(expectedSourceSha) || !isSha(expectedCandidateSha)) {
		throw new Error('expected_revision_must_be_a_full_sha');
	}
	if (expectedSourceSha !== expectedCandidateSha) throw new Error('source_and_candidate_revisions_must_match');
	for (const key of [
		'branch',
		'source_sha',
		'base_sha',
		'clean',
		'base_present',
		'commit_present',
		'base_is_ancestor'
	]) {
		if (identity[key] !== actual[key]) throw new Error('checkout_identity_changed');
	}
	if (!JIG181_EXPECTED_BRANCHES.includes(actual.branch)) throw new Error('branch_not_authorized');
	if (actual.base_sha !== JIG181_BASE_SHA) throw new Error('verified_base_mismatch');
	if (!actual.clean) throw new Error('checkout_not_clean');
	if (!actual.commit_present) throw new Error('candidate_commit_missing');
	if (!actual.base_present || !actual.base_is_ancestor) throw new Error('base_ancestry_invalid');
	if (actual.source_sha !== expectedSourceSha || actual.source_sha !== expectedCandidateSha) {
		throw new Error('candidate_does_not_match_clean_head');
	}
	if (!isSha(actual.source_sha)) throw new Error('checkout_source_is_not_a_full_sha');
	return true;
}

function emptyEvidenceCase(caseSpec, reason) {
	return {
		case_id: caseSpec.id,
		state: 'BLOCKED',
		browser_project: null,
		browser_name: null,
		browser_version: null,
		viewport: caseSpec.viewport,
		screenshot_id: null,
		trace_id: null,
		console_error_count: null,
		page_error_count: null,
		failed_request_count: null,
		layout_shift: null,
		duplicate_request_count: null,
		recorded_at: null,
		reason
	};
}

function redactedEvidenceCase(item, caseSpec) {
	return {
		case_id: caseSpec.id,
		state: item.state,
		browser_project: item.browser_project,
		browser_name: item.browser_name,
		browser_version: item.browser_version,
		viewport: item.viewport,
		screenshot_id: safeEvidenceIdentifier(item.screenshot_id),
		trace_id: safeEvidenceIdentifier(item.trace_id),
		console_error_count: item.console_error_count,
		page_error_count: item.page_error_count,
		failed_request_count: item.failed_request_count,
		layout_shift: item.layout_shift,
		duplicate_request_count: item.duplicate_request_count,
		recorded_at: item.recorded_at
	};
}

function validateEvidenceCase(item, candidateSha, now) {
	assertExactKeys(item, EVIDENCE_CASE_KEYS, 'evidence_case');
	const caseSpec = caseById(item.case_id);
	if (!caseSpec) throw new Error('evidence_unknown_case');
	if (item.viewport !== caseSpec.viewport || !viewportById(item.viewport)) {
		throw new Error('evidence_viewport_mismatch');
	}
	if (item.browser_project !== `jig181-${caseSpec.viewport}`) throw new Error('evidence_browser_project_mismatch');
	if (item.browser_name !== 'chromium' || !isSafeVersion(item.browser_version)) {
		throw new Error('evidence_browser_identity_invalid');
	}
	if (!ALLOWED_GATE_STATES.has(item.state)) throw new Error('evidence_state_invalid');
	for (const key of ['console_error_count', 'page_error_count', 'failed_request_count', 'duplicate_request_count']) {
		if (!isNonNegativeInteger(item[key])) throw new Error('evidence_metric_invalid');
	}
	if (!isFiniteNonNegative(item.layout_shift)) throw new Error('evidence_layout_shift_invalid');
	if (item.screenshot_id !== null && !isSafeId(item.screenshot_id)) throw new Error('evidence_screenshot_id_invalid');
	if (item.trace_id !== null && !isSafeId(item.trace_id)) throw new Error('evidence_trace_id_invalid');
	if (item.state === 'PASS' && item.screenshot_id === null && item.trace_id === null) {
		throw new Error('evidence_identifier_missing');
	}
	const timestamp = parseTimestamp(item.recorded_at, now);
	if (!timestamp.ok) throw new Error(timestamp.reason);
	if (!isSha(candidateSha)) throw new Error('candidate_sha_invalid');

	const thresholdFailure =
		item.console_error_count > 0 ||
		item.page_error_count > 0 ||
		item.failed_request_count > 0 ||
		item.layout_shift > JIG181_LAYOUT_SHIFT_THRESHOLD ||
		item.duplicate_request_count > JIG181_DUPLICATE_REQUEST_THRESHOLD;
	const state = item.state === 'PASS' && thresholdFailure ? 'FAIL' : item.state;
	return {
		caseSpec,
		item: redactedEvidenceCase({ ...item, state }, caseSpec),
		thresholdFailure
	};
}

export function validateLocalEvidenceManifest(manifest, candidateSha, now = Date.now()) {
	assertExactKeys(manifest, EVIDENCE_TOP_LEVEL_KEYS, 'evidence_manifest');
	if (manifest.schema_version !== JIG181_EVIDENCE_SCHEMA_VERSION) throw new Error('evidence_schema_version_invalid');
	if (manifest.ticket !== JIG181_TICKET) throw new Error('evidence_ticket_mismatch');
	if (manifest.candidate_sha !== candidateSha || !isSha(manifest.candidate_sha)) {
		throw new Error('evidence_candidate_mismatch');
	}
	const captured = parseTimestamp(manifest.captured_at, now);
	if (!captured.ok) throw new Error(captured.reason);
	assertExactKeys(manifest.browser, EVIDENCE_BROWSER_KEYS, 'evidence_browser');
	if (manifest.browser.name !== 'chromium' || !isSafeVersion(manifest.browser.version)) {
		throw new Error('evidence_browser_invalid');
	}
	if (!Array.isArray(manifest.cases)) throw new Error('evidence_cases_missing');

	const seen = new Set();
	const validated = [];
	for (const item of manifest.cases) {
		const result = validateEvidenceCase(item, candidateSha, now);
		if (seen.has(result.caseSpec.id)) throw new Error('evidence_duplicate_case');
		seen.add(result.caseSpec.id);
		validated.push(result);
	}
	for (const caseSpec of JIG181_CASES) {
		if (!seen.has(caseSpec.id)) throw new Error('evidence_missing_case');
	}
	if (seen.size !== JIG181_CASES.length) throw new Error('evidence_case_count_invalid');

	const cases = JIG181_CASES.map((caseSpec) => validated.find((item) => item.caseSpec.id === caseSpec.id).item);
	const failed = cases.filter((item) => item.state === 'FAIL').length;
	const blocked = cases.filter((item) => item.state === 'BLOCKED').length;
	const skipped = cases.filter((item) => item.state === 'SKIPPED').length;
	const accepted = cases.every((item) => item.state === 'PASS');
	return {
		state: accepted ? 'PASS' : failed > 0 ? 'FAIL' : blocked > 0 ? 'BLOCKED' : 'SKIPPED',
		accepted,
		accepted_screenshot_set: accepted && cases.every((item) => item.screenshot_id || item.trace_id),
		captured_at: manifest.captured_at,
		browser: { name: manifest.browser.name, version: manifest.browser.version },
		cases,
		case_counts: {
			pass: cases.filter((item) => item.state === 'PASS').length,
			fail: failed,
			blocked,
			skip: skipped
		},
		reason: accepted ? null : failed ? 'browser_threshold_or_case_failed' : blocked ? 'browser_case_blocked' : 'browser_case_skipped'
	};
}

export async function loadLocalEvidenceManifest(path, candidateSha, now = Date.now()) {
	try {
		const evidenceFile = assertSafeArtifactPath(path, { mustExist: true });
		const raw = await readFile(evidenceFile, 'utf8');
		return validateLocalEvidenceManifest(JSON.parse(raw), candidateSha, now);
	} catch {
		return {
			state: 'BLOCKED',
			accepted: false,
			accepted_screenshot_set: false,
			captured_at: null,
			browser: null,
			cases: JIG181_CASES.map((caseSpec) => emptyEvidenceCase(caseSpec, 'browser_evidence_invalid_or_missing')),
			case_counts: { pass: 0, fail: 0, blocked: JIG181_CASES.length, skip: 0 },
			reason: 'browser_evidence_invalid_or_missing'
		};
	}
}

function emptyDeviceEvidence(reason) {
	return {
		state: 'BLOCKED',
		reason,
		device_name: JIG181_REQUIRED_DEVICE.name,
		browser_name: JIG181_REQUIRED_DEVICE.browser,
		browser_version: null,
		evidence_id: null,
		screenshot_id: null,
		trace_id: null,
		console_error_count: null,
		page_error_count: null,
		failed_request_count: null,
		layout_shift: null,
		duplicate_request_count: null,
		recorded_at: null
	};
}

export function validatePhysicalDeviceEvidence(evidence, candidateSha, now = Date.now()) {
	if (!evidence) return emptyDeviceEvidence('physical_device_evidence_missing');
	try {
		assertExactKeys(evidence, DEVICE_EVIDENCE_KEYS, 'device_evidence');
		if (evidence.schema_version !== JIG181_EVIDENCE_SCHEMA_VERSION) throw new Error('device_schema_version_invalid');
		if (evidence.ticket !== JIG181_TICKET || evidence.candidate_sha !== candidateSha) throw new Error('device_candidate_mismatch');
		if (evidence.execution !== 'physical_device' || evidence.emulation !== false) throw new Error('device_execution_not_physical');
		if (evidence.device_name !== JIG181_REQUIRED_DEVICE.name || evidence.browser_name !== JIG181_REQUIRED_DEVICE.browser) {
			throw new Error('device_identity_mismatch');
		}
		if (!isSafeVersion(evidence.os_version) || !isSafeVersion(evidence.browser_version) || !isSafeId(evidence.evidence_id)) {
			throw new Error('device_metadata_invalid');
		}
		if (evidence.screenshot_id !== null && !isSafeId(evidence.screenshot_id)) throw new Error('device_screenshot_id_invalid');
		if (evidence.trace_id !== null && !isSafeId(evidence.trace_id)) throw new Error('device_trace_id_invalid');
		if (evidence.screenshot_id === null && evidence.trace_id === null) throw new Error('device_evidence_identifier_missing');
		for (const key of ['console_error_count', 'page_error_count', 'failed_request_count', 'duplicate_request_count']) {
			if (!isNonNegativeInteger(evidence[key])) throw new Error('device_metric_invalid');
		}
		if (!isFiniteNonNegative(evidence.layout_shift)) throw new Error('device_layout_shift_invalid');
		const timestamp = parseTimestamp(evidence.captured_at, now);
		if (!timestamp.ok) throw new Error(timestamp.reason);
		if (evidence.state !== 'PASS') throw new Error('device_state_not_pass');
		if (
			evidence.console_error_count > 0 ||
			evidence.page_error_count > 0 ||
			evidence.failed_request_count > 0 ||
			evidence.layout_shift > JIG181_LAYOUT_SHIFT_THRESHOLD ||
			evidence.duplicate_request_count > JIG181_DUPLICATE_REQUEST_THRESHOLD
		) {
			throw new Error('device_threshold_failed');
		}
		return {
			state: 'PASS',
			reason: null,
			device_name: evidence.device_name,
			browser_name: evidence.browser_name,
			browser_version: evidence.browser_version,
			evidence_id: evidence.evidence_id,
			screenshot_id: evidence.screenshot_id,
			trace_id: evidence.trace_id,
			console_error_count: evidence.console_error_count,
			page_error_count: evidence.page_error_count,
			failed_request_count: evidence.failed_request_count,
			layout_shift: evidence.layout_shift,
			duplicate_request_count: evidence.duplicate_request_count,
			recorded_at: evidence.captured_at
		};
	} catch (error) {
		return emptyDeviceEvidence(error instanceof Error ? error.message : 'device_evidence_invalid');
	}
}

export async function loadPhysicalDeviceEvidence(path, candidateSha, now = Date.now()) {
	try {
		const evidenceFile = assertSafeArtifactPath(path, { mustExist: true });
		return validatePhysicalDeviceEvidence(JSON.parse(await readFile(evidenceFile, 'utf8')), candidateSha, now);
	} catch {
		return emptyDeviceEvidence('physical_device_evidence_unreadable');
	}
}

export function parseAuthority(value, candidateSha, now = Date.now()) {
	assertExactKeys(value, AUTHORITY_KEYS, 'database_authority');
	if (value.schema_version !== 1 || value.scope !== 'disposable-local') throw new Error('database_authority_scope_invalid');
	if (value.candidate_sha !== candidateSha || !isSha(candidateSha)) throw new Error('database_authority_candidate_mismatch');
	if (!SAFE_DB_NAME_RE.test(value.database_name) || value.loopback !== true || value.allows_test_mutation !== true) {
		throw new Error('database_authority_not_safe');
	}
	if (typeof value.expires_at !== 'string' || !value.expires_at || !Number.isFinite(Date.parse(value.expires_at))) {
		throw new Error('database_authority_expiry_invalid');
	}
	const timestamp = Date.parse(value.expires_at);
	if (timestamp <= now) throw new Error('database_authority_expired');
	if (timestamp - now > JIG181_MAX_AUTHORITY_LIFETIME_MS) {
		throw new Error('database_authority_expiry_too_far');
	}
	return value;
}

function localDatabaseUrlIsSafe(value, databaseName) {
	if (typeof value !== 'string' || !value) return false;
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return false;
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return false;
	if (parsed.pathname.replace(/^\//, '') !== databaseName) return false;
	return true;
}

async function authorizeBrowserExecution(authorityPath, candidateSha, now) {
	if (!authorityPath) return { ok: false, reason: 'isolated_disposable_database_authority_missing' };
	const databaseUrl = process.env.JIG181_E2E_DATABASE_URL;
	if (!databaseUrl) return { ok: false, reason: 'isolated_disposable_database_url_missing' };
	try {
		const authorityFile = assertSafeArtifactPath(authorityPath, { mustExist: true });
		const authority = parseAuthority(JSON.parse(await readFile(authorityFile, 'utf8')), candidateSha, now);
		if (!localDatabaseUrlIsSafe(databaseUrl, authority.database_name)) {
			return { ok: false, reason: 'database_url_is_not_loopback_scoped' };
		}
		return { ok: true, authority };
	} catch {
		return { ok: false, reason: 'database_authority_invalid' };
	}
}

export function buildPlaywrightCommand() {
	return [
		'exec',
		'playwright',
		'test',
		'--config=playwright.jig181.config.ts'
	];
}

function exactRequiredGateSet(gates) {
	if (!Array.isArray(gates) || gates.length !== JIG181_REQUIRED_GATE_IDS.length) return false;
	const ids = gates.map((item) => item?.id);
	return new Set(ids).size === ids.length && JIG181_REQUIRED_GATE_IDS.every((id) => ids.includes(id));
}

function exactRequiredIdSet(ids) {
	return Array.isArray(ids) &&
		ids.length === JIG181_REQUIRED_GATE_IDS.length &&
		new Set(ids).size === ids.length &&
		JIG181_REQUIRED_GATE_IDS.every((id) => ids.includes(id));
}

/**
 * Return the only success code the public command is allowed to emit.
 * This deliberately re-checks the serialized record instead of trusting the
 * decision string written by a caller or a partially collected matrix.
 */
export function releaseExitCode(record) {
	if (!objectValue(record) || record.schema_version !== JIG181_EVIDENCE_SCHEMA_VERSION || record.ticket !== JIG181_TICKET) {
		return 1;
	}
	if (
		record.release_decision !== 'RELEASE' ||
		!exactRequiredIdSet(record.required_gate_ids) ||
		!exactRequiredGateSet(record.gates)
	) return 1;
	if (!objectValue(record.browser_execution) || typeof record.browser_execution.requested !== 'boolean') return 1;
	if (
		record.browser_execution.requested === true &&
		(record.browser_execution.state !== 'PASS' || record.browser_execution.playwright_exit_code !== 0)
	) return 1;
	if (!objectValue(record.checkout) || !JIG181_EXPECTED_BRANCHES.includes(record.checkout.branch)) return 1;
	if (
		record.checkout.clean !== true ||
		record.checkout.base_present !== true ||
		record.checkout.commit_present !== true ||
		record.checkout.base_is_ancestor !== true ||
		record.checkout.base_sha !== JIG181_BASE_SHA ||
		!isSha(record.checkout.source_sha) ||
		!objectValue(record.candidate) ||
		record.candidate.source_sha !== record.checkout.source_sha ||
		record.candidate.base_sha !== JIG181_BASE_SHA
	) {
		return 1;
	}
	if (record.gates.some((item) => !objectValue(item) || item.state !== 'PASS')) return 1;
	if (
		!objectValue(record.local_browser_evidence) ||
		record.local_browser_evidence.state !== 'PASS' ||
	record.local_browser_evidence.accepted_screenshot_set !== true ||
		!Array.isArray(record.local_browser_evidence.cases) ||
		record.local_browser_evidence.cases.length !== JIG181_CASES.length ||
	record.local_browser_evidence.case_counts?.pass !== JIG181_CASES.length ||
		record.local_browser_evidence.case_counts?.fail !== 0 ||
		record.local_browser_evidence.case_counts?.blocked !== 0 ||
		record.local_browser_evidence.case_counts?.skip !== 0
	) return 1;
	if (!objectValue(record.physical_device_evidence) || record.physical_device_evidence.state !== 'PASS') return 1;
	return 0;
}

export function buildPlaywrightEnvironment({
	candidateSha,
	authority,
	evidencePath,
	evidenceDir,
	databaseUrl,
	sourceEnvironment = process.env
}) {
	const environment = {};
	for (const key of PLAYWRIGHT_ENV_ALLOWLIST) {
		if (typeof sourceEnvironment?.[key] === 'string' && sourceEnvironment[key]) {
			environment[key] = sourceEnvironment[key];
		}
	}
	return {
		...environment,
		JIG181_UI_MATRIX_RUN: '1',
		JIG181_E2E_AUTHORIZED: '1',
		JIG181_CANDIDATE_SHA: candidateSha,
		JIG181_EVIDENCE_OUTPUT: evidencePath,
		JIG181_EVIDENCE_DIR: evidenceDir,
		JIG181_E2E_DATABASE_URL: databaseUrl,
		DATABASE_URL: databaseUrl,
		NEWSCRAFT_TEST_DATABASE_URL: databaseUrl,
		AGENT_GATEWAY_URL: 'http://127.0.0.1:9',
		NEWSCRAFT_HERMES_URL: 'http://127.0.0.1:9',
		E2E_SECRET: 'newscraft-jig181-local-secret',
		JIG181_DATABASE_NAME: authority.database_name
	};
}

async function runPlaywrightMatrix({ repoRoot, candidateSha, authority, evidencePath, evidenceDir }) {
	const environment = buildPlaywrightEnvironment({
		candidateSha,
		authority,
		evidencePath,
		evidenceDir,
		databaseUrl: process.env.JIG181_E2E_DATABASE_URL
	});
	const result = spawnSync('pnpm', buildPlaywrightCommand(), {
		cwd: repoRoot,
		env: environment,
		encoding: 'utf8',
		stdio: ['ignore', 'ignore', 'ignore']
	});
	return { exit_code: result.status ?? 1, signal: result.signal ?? null };
}

function redactedCheckout(identity) {
	return {
		branch: typeof identity?.branch === 'string' ? identity.branch : null,
		source_sha: isSha(identity?.source_sha) ? identity.source_sha : null,
		base_sha: identity?.base_sha === JIG181_BASE_SHA ? JIG181_BASE_SHA : null,
		clean: identity?.clean === true,
		base_present: identity?.base_present === true,
		commit_present: identity?.commit_present === true,
		base_is_ancestor: identity?.base_is_ancestor === true
	};
}

function gate(id, state, reason = null, evidence = null) {
	return {
		id,
		state: ALLOWED_GATE_STATES.has(state) ? state : 'BLOCKED',
		...(reason ? { reason } : {}),
		...(evidence ? { evidence } : {})
	};
}

function browserExecutionAllowsRelease(browserExecution) {
	if (!objectValue(browserExecution) || typeof browserExecution.requested !== 'boolean') return false;
	return browserExecution.requested === false ||
		(browserExecution.state === 'PASS' && browserExecution.exit_code === 0);
}

function evaluateRelease(identityValid, localEvidence, deviceEvidence, browserExecution) {
	const gates = [
		gate('checkout_identity', identityValid ? 'PASS' : 'FAIL', identityValid ? null : 'checkout_identity_invalid'),
		gate(
			'screenshot_console_evidence',
			localEvidence.accepted_screenshot_set ? 'PASS' : localEvidence.state,
			localEvidence.accepted_screenshot_set ? null : localEvidence.reason
		),
		...localEvidence.cases.map((item) =>
			gate(`local_browser:${item.case_id}`, item.state, item.state === 'PASS' ? null : 'browser_case_not_accepted', {
				browser_project: item.browser_project,
				viewport: item.viewport,
				screenshot_id: item.screenshot_id,
				trace_id: item.trace_id,
				console_error_count: item.console_error_count,
				page_error_count: item.page_error_count,
				failed_request_count: item.failed_request_count,
				layout_shift: item.layout_shift,
				duplicate_request_count: item.duplicate_request_count,
				recorded_at: item.recorded_at
			})
		),
		gate(
			'physical_device:iphone-17-pro-safari',
			deviceEvidence.state,
			deviceEvidence.reason,
			{
				device_name: deviceEvidence.device_name,
				browser_name: deviceEvidence.browser_name,
				browser_version: deviceEvidence.browser_version,
				evidence_id: deviceEvidence.evidence_id,
				screenshot_id: deviceEvidence.screenshot_id,
				trace_id: deviceEvidence.trace_id,
				console_error_count: deviceEvidence.console_error_count,
				page_error_count: deviceEvidence.page_error_count,
				failed_request_count: deviceEvidence.failed_request_count,
				layout_shift: deviceEvidence.layout_shift,
				duplicate_request_count: deviceEvidence.duplicate_request_count,
				recorded_at: deviceEvidence.recorded_at
			}
		)
	];
	const ids = gates.map((item) => item.id);
	const exactGateSet = ids.length === JIG181_REQUIRED_GATE_IDS.length &&
		new Set(ids).size === ids.length &&
		JIG181_REQUIRED_GATE_IDS.every((id) => ids.includes(id));
	const release =
		identityValid &&
		exactGateSet &&
		gates.every((item) => item.state === 'PASS') &&
		browserExecutionAllowsRelease(browserExecution);
	return { gates, release_decision: release ? 'RELEASE' : 'BLOCK RELEASE' };
}

export function assertRedactedReleaseRecord(record) {
	function visit(value) {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!objectValue(value)) return;
		for (const [key, child] of Object.entries(value)) {
			if (FORBIDDEN_RECORD_KEY_RE.test(key)) throw new Error('release_record_contains_forbidden_key');
			visit(child);
		}
	}
	visit(record);
	const encoded = JSON.stringify(record);
	if (FORBIDDEN_RECORD_VALUE_RE.test(encoded)) throw new Error('release_record_contains_forbidden_value');
	return true;
}

export function buildReleaseRecord({ identity, identityValid, localEvidence, deviceEvidence, browserExecution, now = Date.now() }) {
	const release = evaluateRelease(identityValid, localEvidence, deviceEvidence, browserExecution);
	const record = {
		schema_version: JIG181_EVIDENCE_SCHEMA_VERSION,
		ticket: JIG181_TICKET,
		recorded_at: new Date(now).toISOString(),
		checkout: redactedCheckout(identity),
		candidate: {
			source_sha: redactedCheckout(identity).source_sha,
			base_sha: JIG181_BASE_SHA
		},
		viewport_matrix: JIG181_VIEWPORTS.map(({ id, width, height, kind }) => ({ id, width, height, kind })),
		browser_execution: {
			requested: browserExecution.requested === true,
			state: browserExecution.state,
			reason: browserExecution.reason,
			playwright_exit_code: browserExecution.exit_code ?? null
		},
		local_browser_evidence: {
			state: localEvidence.state,
			accepted_screenshot_set: localEvidence.accepted_screenshot_set,
			browser: localEvidence.browser,
			captured_at: localEvidence.captured_at,
			case_counts: localEvidence.case_counts,
			cases: localEvidence.cases,
			reason: localEvidence.reason
		},
		physical_device_evidence: deviceEvidence,
		thresholds: {
			max_layout_shift: JIG181_LAYOUT_SHIFT_THRESHOLD,
			max_duplicate_requests: JIG181_DUPLICATE_REQUEST_THRESHOLD,
			max_evidence_age_ms: JIG181_MAX_EVIDENCE_AGE_MS
		},
		required_gate_ids: [...JIG181_REQUIRED_GATE_IDS],
		gates: release.gates,
		release_decision: release.release_decision,
		limitations: [
			'Browser execution requires an explicitly authorized disposable loopback database.',
			'Effective CSS zoom is local browser evidence; native browser zoom and physical rotation remain separate device limits.',
			'Physical iPhone evidence is not inferred from desktop emulation.',
			'No production, external provider, remote endpoint, or live deployment evidence is represented.'
		]
	};
	assertRedactedReleaseRecord(record);
	return record;
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
	if (objectValue(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function pathIsWithin(root, candidate) {
	const relativePath = relative(root, candidate);
	return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

/**
 * Keep every artifact operation below the dedicated root and reject symlinks
 * in all existing path components. Missing final components are allowed for
 * writes, but their existing parents are still checked before creation.
 */
export function assertSafeArtifactPath(path, { mustExist = false } = {}) {
	const resolved = resolve(path);
	const root = resolve(SAFE_ARTIFACT_ROOT);
	if (!pathIsWithin(root, resolved)) throw new Error('artifact_path_outside_dedicated_directory');

	let current = resolved;
	let resolvedExists = false;
	let rootExists = false;
	let rootMissing = false;
	const existingPaths = [];
	while (true) {
		try {
			const stats = lstatSync(current);
			if (stats.isSymbolicLink()) throw new Error('artifact_path_symlink');
			existingPaths.push(current);
			if (current === resolved) resolvedExists = true;
			if (current === root) {
				rootExists = true;
				break;
			}
			if (rootMissing && current === dirname(root)) break;
			current = dirname(current);
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			if (current === root) {
				if (mustExist) throw new Error('artifact_path_missing');
				rootMissing = true;
				current = dirname(current);
				continue;
			}
			current = dirname(current);
		}
		if (current === dirname(current)) throw new Error('artifact_root_missing');
	}
	if (mustExist && !resolvedExists) throw new Error('artifact_path_missing');

	if (rootExists) {
		const realRoot = realpathSync(root);
		const realRepoRoot = realpathSync(REPO_ROOT);
		if (!pathIsWithin(realRepoRoot, realRoot)) {
			throw new Error('artifact_path_outside_dedicated_directory');
		}
		for (const existingPath of existingPaths) {
			if (!pathIsWithin(realRoot, realpathSync(existingPath))) {
				throw new Error('artifact_path_outside_dedicated_directory');
			}
		}
	} else {
		// The root may be created by ensureSafeArtifactDirectory. Verify its
		// existing repository parent before allowing that creation.
		const realParent = realpathSync(dirname(root));
		if (!pathIsWithin(realpathSync(REPO_ROOT), realParent)) {
			throw new Error('artifact_path_outside_dedicated_directory');
		}
	}
	return resolved;
}

export async function ensureSafeArtifactDirectory(path) {
	const directory = assertSafeArtifactPath(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	assertSafeArtifactPath(directory, { mustExist: true });
	return directory;
}

export async function writeReleaseRecord(path, record) {
	const output = assertSafeArtifactPath(path);
	await ensureSafeArtifactDirectory(dirname(output));
	assertSafeArtifactPath(output);
	const encoded = `${stableJson(record)}\n`;
	await writeFile(output, encoded, { encoding: 'utf8', mode: 0o600 });
	await chmod(output, 0o600);
	return {
		path: output,
		sha256: createHash('sha256').update(encoded).digest('hex')
	};
}

function defaultOutputPath(candidateSha) {
	const short = isSha(candidateSha) ? candidateSha.slice(0, 12) : 'invalid';
	return resolve(SAFE_ARTIFACT_ROOT, `ui-matrix-${short}.json`);
}

function failureIdentity() {
	try {
		return checkoutIdentity();
	} catch {
		return {
			branch: null,
			source_sha: null,
			base_sha: null,
			clean: false,
			base_present: false,
			commit_present: false,
			base_is_ancestor: false
		};
	}
}

export async function runMatrix({
	repoRoot = REPO_ROOT,
	expectedSourceSha,
	expectedCandidateSha,
	evidenceManifestPath = null,
	deviceEvidencePath = null,
	databaseAuthorityPath = null,
	runBrowser = false,
	outputPath = null,
	now = Date.now()
} = {}) {
	const identity = checkoutIdentity(repoRoot);
	let identityValid = false;
	try {
		identityValid = validateCheckoutIdentity(identity, expectedSourceSha, expectedCandidateSha);
	} catch {
		identityValid = false;
	}
	const candidateSha = identity.source_sha;
	let browserExecution = {
		requested: runBrowser,
		state: 'BLOCKED',
		reason: runBrowser ? 'isolated_disposable_database_authority_missing' : 'browser_execution_not_requested',
		exit_code: null
	};
	let evidencePath = evidenceManifestPath ? assertSafeArtifactPath(evidenceManifestPath) : null;
	const safeDeviceEvidencePath = deviceEvidencePath ? assertSafeArtifactPath(deviceEvidencePath) : null;
	let evidenceDir = resolve(SAFE_ARTIFACT_ROOT, `browser-${isSha(candidateSha) ? candidateSha.slice(0, 12) : 'invalid'}`);
	if (runBrowser && identityValid) {
		const authority = await authorizeBrowserExecution(databaseAuthorityPath, candidateSha, now);
		if (authority.ok) {
			await ensureSafeArtifactDirectory(evidenceDir);
			evidencePath = evidencePath || resolve(evidenceDir, 'evidence.json');
			assertSafeArtifactPath(evidencePath);
			browserExecution = {
				requested: true,
				state: 'RUNNING',
				reason: null,
				exit_code: null
			};
			browserExecution = await runPlaywrightMatrix({
				repoRoot,
				candidateSha,
				authority: authority.authority,
				evidencePath,
				evidenceDir
			});
			browserExecution.requested = true;
			browserExecution.state = browserExecution.exit_code === 0 ? 'PASS' : 'FAIL';
			browserExecution.reason = browserExecution.exit_code === 0 ? null : 'playwright_matrix_failed';
		} else {
			browserExecution.reason = authority.reason;
		}
	} else if (runBrowser && !identityValid) {
		browserExecution.reason = 'checkout_identity_invalid';
	}

	const localEvidence = evidencePath
		? await loadLocalEvidenceManifest(evidencePath, candidateSha, now)
		: {
			state: 'BLOCKED',
			accepted: false,
			accepted_screenshot_set: false,
			captured_at: null,
			browser: null,
			cases: JIG181_CASES.map((caseSpec) => emptyEvidenceCase(caseSpec, browserExecution.reason)),
			case_counts: { pass: 0, fail: 0, blocked: JIG181_CASES.length, skip: 0 },
			reason: browserExecution.reason
		};
	const deviceEvidence = safeDeviceEvidencePath
		? await loadPhysicalDeviceEvidence(safeDeviceEvidencePath, candidateSha, now)
		: emptyDeviceEvidence('physical_device_evidence_missing');
	const record = buildReleaseRecord({ identity, identityValid, localEvidence, deviceEvidence, browserExecution, now });
	const output = await writeReleaseRecord(outputPath || defaultOutputPath(candidateSha), record);
	return { record, output, identityValid, browserExecution };
}

export function parseArgs(argv) {
	const args = {};
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--run-browser') {
			if (seen.has('run_browser')) throw new Error('unknown_argument');
			seen.add('run_browser');
			args.run_browser = true;
			continue;
		}
		if (arg === '--help') {
			args.help = true;
			continue;
		}
		const [inlineKey, inlineValue] = arg.split('=', 2);
		const key = inlineKey.startsWith('--') ? inlineKey.slice(2).replaceAll('-', '_') : null;
		if (!key || !CLI_VALUE_KEYS.has(key) || seen.has(key)) throw new Error('unknown_argument');
		seen.add(key);
		if (inlineValue !== undefined) {
			args[key] = inlineValue;
		} else {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) throw new Error('argument_value_missing');
			args[key] = value;
			index += 1;
		}
	}
	return args;
}

function printUsage() {
	console.log('pnpm ui:matrix:jig181 --source-sha <sha> --candidate-sha <sha> [--output <.tmp path>] [--evidence-manifest <path>] [--device-evidence <path>] [--run-browser --database-authority <path>]');
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) {
		printUsage();
		return 0;
	}
	const expectedSourceSha = args.source_sha;
	const expectedCandidateSha = args.candidate_sha;
	const outputPath = args.output ? resolve(REPO_ROOT, args.output) : null;
	const result = await runMatrix({
		repoRoot: REPO_ROOT,
		expectedSourceSha,
		expectedCandidateSha,
		evidenceManifestPath: args.evidence_manifest ? resolve(REPO_ROOT, args.evidence_manifest) : null,
		deviceEvidencePath: args.device_evidence ? resolve(REPO_ROOT, args.device_evidence) : null,
		databaseAuthorityPath: args.database_authority ? resolve(REPO_ROOT, args.database_authority) : null,
		runBrowser: args.run_browser === true,
		outputPath
	});
	console.log(
		`${JIG181_TICKET}_UI_MATRIX local_browser=${result.record.local_browser_evidence.state} ` +
			`physical_device=${result.record.physical_device_evidence.state} ` +
			`release_decision=${result.record.release_decision} ` +
			`record_sha256=${result.output.sha256}`
	);
	console.log(`record_path=${result.output.path}`);
	return releaseExitCode(result.record);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((code) => process.exit(code)).catch(async (error) => {
		const output = process.argv.includes('--output')
			? resolve(REPO_ROOT, process.argv[process.argv.indexOf('--output') + 1] || '')
			: defaultOutputPath(null);
		const identity = failureIdentity();
		const record = {
			schema_version: JIG181_EVIDENCE_SCHEMA_VERSION,
			ticket: JIG181_TICKET,
			recorded_at: new Date().toISOString(),
			checkout: redactedCheckout(identity),
			candidate: { source_sha: redactedCheckout(identity).source_sha, base_sha: JIG181_BASE_SHA },
			browser_execution: {
				requested: process.argv.includes('--run-browser'),
				state: 'FAIL',
				reason: 'runner_failed',
				playwright_exit_code: null
			},
			local_browser_evidence: {
				state: 'FAIL',
				accepted_screenshot_set: false,
				browser: null,
				captured_at: null,
				case_counts: { pass: 0, fail: 0, blocked: JIG181_CASES.length, skip: 0 },
				cases: JIG181_CASES.map((caseSpec) => emptyEvidenceCase(caseSpec, 'runner_failed')),
				reason: 'runner_failed'
			},
			physical_device_evidence: emptyDeviceEvidence('physical_device_evidence_missing'),
			thresholds: {
				max_layout_shift: JIG181_LAYOUT_SHIFT_THRESHOLD,
				max_duplicate_requests: JIG181_DUPLICATE_REQUEST_THRESHOLD,
				max_evidence_age_ms: JIG181_MAX_EVIDENCE_AGE_MS
			},
			required_gate_ids: [...JIG181_REQUIRED_GATE_IDS],
			gates: [],
			release_decision: 'BLOCK RELEASE',
			limitations: ['Runner failed before collecting browser evidence.']
		};
		try {
			const written = await writeReleaseRecord(output, record);
			console.error(`${JIG181_TICKET}_UI_MATRIX local_browser=FAIL release_decision=BLOCK RELEASE record_sha256=${written.sha256}`);
			console.error(`record_path=${written.path}`);
		} catch {
			console.error(`${JIG181_TICKET}_UI_MATRIX runner_failed`);
		}
		console.error('runner_error=bounded_failure');
		process.exit(1);
	});
}
