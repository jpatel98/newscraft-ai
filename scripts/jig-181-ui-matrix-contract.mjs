export const JIG181_TICKET = 'JIG-181';

export const JIG181_BASE_SHA = '2b5af1dffe5649cac3d353a0b95211d6fa42833e';
export const JIG181_EXPECTED_BRANCHES = Object.freeze([
	'codex/jig-181-ui-matrix',
	'main'
]);

export const JIG181_VIEWPORTS = Object.freeze([
	{ id: 'mobile-320x700', width: 320, height: 700, kind: 'mobile' },
	{ id: 'mobile-390x844', width: 390, height: 844, kind: 'mobile' },
	{ id: 'mobile-430x932', width: 430, height: 932, kind: 'mobile' },
	{ id: 'tablet-768x1024', width: 768, height: 1024, kind: 'tablet' },
	{ id: 'desktop-1440x900', width: 1440, height: 900, kind: 'desktop' }
]);

export const JIG181_CASES = Object.freeze([
	{ id: 'viewport_320x700', viewport: 'mobile-320x700', family: 'viewport' },
	{ id: 'viewport_390x844', viewport: 'mobile-390x844', family: 'viewport' },
	{ id: 'viewport_430x932', viewport: 'mobile-430x932', family: 'viewport' },
	{ id: 'viewport_tablet_768x1024', viewport: 'tablet-768x1024', family: 'viewport' },
	{ id: 'viewport_desktop_1440x900', viewport: 'desktop-1440x900', family: 'viewport' },
	{ id: 'keyboard_open_close', viewport: 'mobile-390x844', family: 'interaction' },
	{ id: 'orientation_rotation', viewport: 'mobile-390x844', family: 'interaction' },
	{ id: 'visual_viewport_offsets', viewport: 'mobile-390x844', family: 'interaction' },
	{ id: 'long_thread_fast_scroll', viewport: 'mobile-390x844', family: 'interaction' },
	{ id: 'drawer_modal_focus_restoration', viewport: 'mobile-320x700', family: 'interaction' },
	{ id: 'zoom_200_reduced_motion', viewport: 'desktop-1440x900', family: 'interaction' },
	{ id: 'network_disconnect_reconnect', viewport: 'mobile-390x844', family: 'network' },
	{ id: 'server_error_retry_cancel', viewport: 'mobile-390x844', family: 'network' },
	{ id: 'stale_tab_duplicate_requests', viewport: 'tablet-768x1024', family: 'network' },
	{ id: 'console_and_layout_stability', viewport: 'desktop-1440x900', family: 'observability' }
]);

export const JIG181_REQUIRED_GATE_IDS = Object.freeze([
	'checkout_identity',
	'screenshot_console_evidence',
	...JIG181_CASES.map((item) => `local_browser:${item.id}`),
	'physical_device:iphone-17-pro-safari'
]);

export const JIG181_REQUIRED_DEVICE = Object.freeze({
	name: 'iPhone 17 Pro',
	browser: 'Safari'
});

export const JIG181_LAYOUT_SHIFT_THRESHOLD = 0.1;
export const JIG181_SETTLING_WINDOW_MS = 250;
export const JIG181_SETTLING_CASE_IDS = Object.freeze([
	'keyboard_open_close',
	'zoom_200_reduced_motion'
]);
export const JIG181_DUPLICATE_REQUEST_THRESHOLD = 0;
export const JIG181_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
export const JIG181_MAX_AUTHORITY_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const JIG181_EVIDENCE_SCHEMA_VERSION = 2;

/**
 * @param {number} observedPostCount
 * @param {number} expectedLogicalPostCount
 */
export function duplicateDurableStartCount(observedPostCount, expectedLogicalPostCount = 1) {
	if (!Number.isInteger(observedPostCount) || observedPostCount < 0 ||
		!Number.isInteger(expectedLogicalPostCount) || expectedLogicalPostCount < 0) {
		throw new Error('durable_start_count_invalid');
	}
	return Math.max(0, observedPostCount - expectedLogicalPostCount);
}

/** @param {string} viewportId */
export function viewportById(viewportId) {
	return JIG181_VIEWPORTS.find((viewport) => viewport.id === viewportId) ?? null;
}

/** @param {string} caseId */
export function caseById(caseId) {
	return JIG181_CASES.find((item) => item.id === caseId) ?? null;
}

/** @param {string} caseId */
export function isSettlingCase(caseId) {
	return JIG181_SETTLING_CASE_IDS.includes(caseId);
}
