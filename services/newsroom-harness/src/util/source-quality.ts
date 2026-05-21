export type SourceQualityState =
	| 'usable'
	| 'blocked_unusable'
	| 'boilerplate_unusable'
	| 'empty_unusable'
	| 'nav_unusable';

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

function normalize(value: string | null | undefined): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
