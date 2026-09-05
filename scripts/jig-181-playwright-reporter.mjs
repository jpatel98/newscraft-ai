import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assertSafeArtifactPath, ensureSafeArtifactDirectory } from './jig-181-ui-matrix.mjs';
import { JIG181_EVIDENCE_SCHEMA_VERSION } from './jig-181-ui-matrix-contract.mjs';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CASE_ID_RE = /^[a-z0-9_]{1,80}$/;

function safeId(value) {
	return typeof value === 'string' && SAFE_ID_RE.test(value) ? value : null;
}

function metric(value) {
	return Number.isInteger(value) && value >= 0 ? value : null;
}

function shift(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function windowMs(value) {
	return Number.isInteger(value) && value > 0 ? value : null;
}

function parseEvidenceAnnotation(test) {
	const annotation = test.annotations.find((item) => item.type === 'jig181-evidence');
	if (!annotation?.description) return null;
	try {
		const value = JSON.parse(annotation.description);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		if (!CASE_ID_RE.test(value.case_id) || !safeId(value.browser_project) || value.browser_name !== 'chromium') return null;
		if (!safeId(value.browser_version) || !safeId(value.viewport)) return null;
		if (!Object.prototype.hasOwnProperty.call(value, 'transition_layout_shift') ||
			!Object.prototype.hasOwnProperty.call(value, 'settling_window_ms')) return null;
		const transitionLayoutShift = value.transition_layout_shift === null ? null : shift(value.transition_layout_shift);
		const settlingWindowMs = value.settling_window_ms === null ? null : windowMs(value.settling_window_ms);
		if ((value.transition_layout_shift !== null && transitionLayoutShift === null) ||
			(value.settling_window_ms !== null && settlingWindowMs === null)) return null;
		return {
			case_id: value.case_id,
			browser_project: value.browser_project,
			browser_name: value.browser_name,
			browser_version: value.browser_version,
			viewport: value.viewport,
			console_error_count: metric(value.console_error_count),
			page_error_count: metric(value.page_error_count),
			failed_request_count: metric(value.failed_request_count),
			layout_shift: shift(value.layout_shift),
			transition_layout_shift: transitionLayoutShift,
			settling_window_ms: settlingWindowMs,
			duplicate_request_count: metric(value.duplicate_request_count),
			state: value.state === 'PASS' ? 'PASS' : 'FAIL'
		};
	} catch {
		return null;
	}
}

async function screenshotIdentifier(attachment, evidenceDir, caseId) {
	if (!attachment?.path) return null;
	try {
		const safeCase = CASE_ID_RE.test(caseId) ? caseId : 'unknown-case';
		const output = assertSafeArtifactPath(resolve(evidenceDir, `${safeCase}.png`));
		await ensureSafeArtifactDirectory(dirname(output));
		assertSafeArtifactPath(output);
		await copyFile(attachment.path, output);
		assertSafeArtifactPath(output, { mustExist: true });
		await chmod(output, 0o600);
		const digest = createHash('sha256').update(await readFile(output)).digest('hex');
		return `sha256:${digest}`;
	} catch {
		return null;
	}
}

export default class Jig181PlaywrightReporter {
	constructor(options = {}) {
		this.output = options.output || process.env.JIG181_EVIDENCE_OUTPUT;
		this.evidenceDir = options.evidenceDir || process.env.JIG181_EVIDENCE_DIR;
		this.results = new Map();
	}

	onTestEnd(test, result) {
		// Playwright may report more than one result for a retried test. Keep
		// only the final result so a successful retry cannot create a duplicate
		// required case while a failed final result still fails closed.
		this.results.set(test.id, { test, result });
	}

	async onEnd() {
		const candidateSha = process.env.JIG181_CANDIDATE_SHA || null;
		const evidenceDir = this.evidenceDir ? assertSafeArtifactPath(resolve(this.evidenceDir)) : null;
		if (evidenceDir) await ensureSafeArtifactDirectory(evidenceDir);
		const cases = [];
		for (const { test, result } of this.results.values()) {
			const annotation = parseEvidenceAnnotation(test);
			if (!annotation) continue;
			const screenshot = result.attachments.find((attachment) => attachment.name === 'jig181-screenshot');
			const screenshotId = result.status === 'passed' && evidenceDir
				? await screenshotIdentifier(screenshot, evidenceDir, annotation.case_id)
				: null;
			cases.push({
				case_id: annotation.case_id,
				state: result.status === 'passed' && annotation.state === 'PASS' && screenshotId ? 'PASS' : 'FAIL',
				browser_project: annotation.browser_project,
				browser_name: annotation.browser_name,
				browser_version: annotation.browser_version,
				viewport: annotation.viewport,
				screenshot_id: screenshotId,
				trace_id: null,
				console_error_count: annotation.console_error_count,
				page_error_count: annotation.page_error_count,
				failed_request_count: annotation.failed_request_count,
				layout_shift: annotation.layout_shift,
				transition_layout_shift: annotation.transition_layout_shift,
				settling_window_ms: annotation.settling_window_ms,
				duplicate_request_count: annotation.duplicate_request_count,
				recorded_at: new Date().toISOString()
			});
		}
		if (!this.output) return;
		const output = assertSafeArtifactPath(resolve(this.output));
		await ensureSafeArtifactDirectory(dirname(output));
		assertSafeArtifactPath(output);
		const browserVersion = cases.find((item) => item.browser_version)?.browser_version || 'unknown';
		const record = {
			schema_version: JIG181_EVIDENCE_SCHEMA_VERSION,
			ticket: 'JIG-181',
			candidate_sha: candidateSha,
			captured_at: new Date().toISOString(),
			browser: { name: 'chromium', version: browserVersion },
			cases
		};
		await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		assertSafeArtifactPath(output, { mustExist: true });
		await chmod(output, 0o600);
	}
}
