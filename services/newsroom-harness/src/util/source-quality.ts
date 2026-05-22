export type SourceQualityState =
	| 'usable'
	| 'blocked_unusable'
	| 'boilerplate_unusable'
	| 'empty_unusable'
	| 'nav_unusable'
	| 'recycled_report_unusable'
	| 'repeated_boilerplate_unusable';

export interface SourceQualityAssessment {
	state: SourceQualityState;
	usable: boolean;
	publicNote: string | null;
	debugReason: string | null;
}

interface SourceQualityInput {
	title?: string | null;
	text?: string | null;
	summary?: string | null;
	statusCode?: number | null;
	limitations?: string[] | null;
	confidence?: number | null;
}

const BLOCKED_LIMITATION_RE = /\b(http\s*(?:4\d\d|5\d\d)|source returned http|unavailable|blocked|captcha|paywall|login|forbidden|access denied)\b/i;

const BOILERPLATE_PATTERNS = [
	/\bjust a moment\b/i,
	/\benable javascript and cookies\b/i,
	/\bchecking your browser\b/i,
	/\bverify you are human\b/i,
	/\bcloudflare\b/i,
	/\bcaptcha\b/i,
	/\baccess denied\b/i,
	/\bforbidden\b/i
];

export function assessSourceQuality(input: SourceQualityInput): SourceQualityAssessment {
	const statusCode = input.statusCode ?? null;
	const limitations = input.limitations ?? [];
	const rawText = stringValue(input.text);
	const rawSummary = stringValue(input.summary);
	const text = normalize(input.text);
	const summary = normalize(input.summary);
	const title = normalize(input.title);
	const body = normalize([summary, text].filter(Boolean).join(' '));
	const combined = normalize([title, summary, text, limitations.join(' ')].filter(Boolean).join(' '));

	if (statusCode && statusCode >= 400) {
		return unusable('blocked_unusable', 'Source could not be read during this run.', `HTTP ${statusCode}`);
	}

	if (limitations.some((limitation) => BLOCKED_LIMITATION_RE.test(limitation))) {
		return unusable('blocked_unusable', 'Source could not be read during this run.', 'blocked source limitation');
	}

	if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(combined))) {
		return unusable(
			'boilerplate_unusable',
			'Source returned access or browser-check text instead of usable story material.',
			'blocked-page boilerplate'
		);
	}

	if (looksLikeRecycledMissionOutput(rawText, rawSummary)) {
		return unusable(
			'recycled_report_unusable',
			'Source looked like recycled mission output instead of a story page.',
			'recycled mission report text'
		);
	}

	if (looksLikeRepeatedBoilerplate(rawText || rawSummary)) {
		return unusable(
			'repeated_boilerplate_unusable',
			'Source returned repeated boilerplate instead of usable story material.',
			'repeated boilerplate text'
		);
	}

	if (looksLikeNavigationOnly(body)) {
		return unusable(
			'nav_unusable',
			'Source returned navigation text instead of usable story material.',
			'navigation-only text'
		);
	}

	if (!body || (!text && summary && title && summary.toLowerCase() === title.toLowerCase())) {
		return unusable('empty_unusable', 'Source did not return usable story text during this run.', 'empty source text');
	}

	if (input.confidence !== null && input.confidence !== undefined && input.confidence <= 0) {
		return unusable('empty_unusable', 'Source did not return usable story text during this run.', 'zero confidence');
	}

	return {
		state: 'usable',
		usable: true,
		publicNote: null,
		debugReason: null
	};
}

function unusable(state: Exclude<SourceQualityState, 'usable'>, publicNote: string, debugReason: string): SourceQualityAssessment {
	return {
		state,
		usable: false,
		publicNote,
		debugReason
	};
}

function looksLikeNavigationOnly(value: string): boolean {
	const text = value.toLowerCase();
	if (!text) return false;
	if (/\bskip to content\b/.test(text) && /\bi want to\b/.test(text)) return true;
	if (/\bmenu\b/.test(text) && /\bsearch\b/.test(text) && /\bsubscribe\b/.test(text) && value.length < 700) {
		return true;
	}
	return false;
}

function looksLikeRecycledMissionOutput(text: string, summary: string): boolean {
	const value = `${summary}\n${text}`;
	if (!value.trim()) return false;
	const reportMarkers = [
		/^#{1,3}\s+summary\b/im,
		/^#{1,3}\s+lead candidates\b/im,
		/^#{1,3}\s+source notes\b/im,
		/^#{1,3}\s+limitations\b/im,
		/\bno publishable lead was found\b/i,
		/\badditional usable sources were recorded\b/i,
		/\btool budget used\b/i,
		/\bbacked by\b.+\bmission\b/i,
		/\bnewsroom:\/\/mission-output\//i
	];
	const matches = reportMarkers.filter((pattern) => pattern.test(value)).length;
	return matches >= 2 || (/^#{1,3}\s+source notes\b/im.test(value) && value.length > 1200);
}

function looksLikeRepeatedBoilerplate(value: string): boolean {
	const lines = value
		.split(/\r?\n+/)
		.map((line) => normalize(line).toLowerCase())
		.filter((line) => line.length >= 12);
	if (lines.length < 8) return false;

	const counts = new Map<string, number>();
	for (const line of lines) {
		const key = line.replace(/[^a-z0-9]+/g, ' ').trim();
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const repeatedLines = [...counts.values()].filter((count) => count >= 3);
	const topCount = Math.max(0, ...counts.values());
	const uniqueRatio = counts.size / lines.length;
	return topCount >= 5 || (repeatedLines.length >= 2 && uniqueRatio <= 0.65);
}

function normalize(value: string | null | undefined): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function stringValue(value: string | null | undefined): string {
	return typeof value === 'string' ? value : '';
}
