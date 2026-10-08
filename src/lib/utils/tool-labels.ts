// Map raw tool names from the gateway into plain-English status copy. A tool
// can fall through several heuristics (substring match), so the final label
// is "Working on it" only when nothing else fits.

interface ToolLabel {
	live: string;
	done: string;
}

export interface ToolStep {
	name: string;
	detail?: string;
	url?: string;
	title?: string;
	arguments?: unknown;
	result?: unknown;
}

interface ToolIntent {
	live: string;
	done: string;
	detail?: string;
}

const TABLE: Array<{ test: RegExp; label: ToolLabel }> = [
	{ test: /^publish_(?:markdown|csv|table|chart|image|artifact)$/i, label: { live: 'Saving file', done: 'File saved' } },
	{ test: /^read_file$/i, label: { live: 'Reading file', done: 'File read' } },
	{ test: /^write_file$/i, label: { live: 'Writing file', done: 'File written' } },
	{ test: /^(?:list_files|list_directory)$/i, label: { live: 'Listing files', done: 'Files listed' } },
	{ test: /assignment[_-]?desk/i, label: { live: 'Planning request', done: 'Request routed' } },
	{ test: /skill[_-]?view|view[_-]?skill/i, label: { live: 'Preparing research', done: 'Research prepared' } },
	{
		test: /delegate[_-]?task|task[_-]?delegate/i,
		label: { live: 'Checking research', done: 'Research checked' }
	},
	{ test: /search|google|bing|duckduckgo|web/i, label: { live: 'Scanning coverage', done: 'Coverage scanned' } },
	{ test: /fetch|read|browse|open|http|url|page/i, label: { live: 'Reading source', done: 'Source read' } },
	{ test: /verify|check|validate|fact/i, label: { live: 'Checking facts', done: 'Facts checked' } },
	{ test: /summari[sz]e|brief|outline/i, label: { live: 'Summarizing', done: 'Summary ready' } },
	{ test: /draft|write|compose/i, label: { live: 'Drafting', done: 'Draft ready' } },
	{ test: /terminal|shell|bash|exec|command/i, label: { live: 'Working with data', done: 'Data processed' } },
	{ test: /file|fs|path|document/i, label: { live: 'Checking files', done: 'Files checked' } },
	{ test: /db|sql|query|select/i, label: { live: 'Querying data', done: 'Data fetched' } }
];

const DETAIL_LIMIT = 96;
const DETAIL_NOISE = new Set([
	'ok',
	'done',
	'end',
	'start',
	'error',
	'failed',
	'running',
	'started',
	'complete',
	'completed',
	'in_progress'
]);

export function liveLabel(name: string): string {
	for (const row of TABLE) if (row.test.test(name)) return row.label.live;
	return 'Working on it';
}

export function doneLabel(name: string): string {
	for (const row of TABLE) if (row.test.test(name)) return row.label.done;
	return 'Tools used';
}

// Dominant label for a set of running tools — picks the most common kind
// so the status copy stays calm even when many fire in parallel.
export function dominantLiveLabel(names: string[]): string {
	if (names.length === 0) return 'Drafting answer';
	const counts = new Map<string, number>();
	for (const name of names) {
		const label = liveLabel(name);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	let best = '';
	let bestCount = -1;
	for (const [label, count] of counts) {
		if (count > bestCount) {
			best = label;
			bestCount = count;
		}
	}
	return best || 'Working on it';
}

export function dominantDoneLabel(names: string[]): string {
	if (names.length === 0) return '';
	const counts = new Map<string, number>();
	for (const name of names) {
		const label = doneLabel(name);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	let best = '';
	let bestCount = -1;
	for (const [label, count] of counts) {
		if (count > bestCount) {
			best = label;
			bestCount = count;
		}
	}
	return best || 'Tools used';
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
}

/** Last display boundary for both current activity and historical replay. */
export function publicActivityText(value: unknown): string {
	if (typeof value !== 'string') return '';
	if (/(?:^|[\s"'`(])(?:\/[\w.]|~[/\\]|[A-Za-z]:\\|\.{1,2}\/)|\b[A-Za-z_.-][\w.-]*\/[\w./-]+|\b[0-9a-f]{8}-[0-9a-f-]{27,}\b|\b[0-9a-f]{32,}\b|\b(?:run|job|call|tool|receipt|ref)[_:-][\w:-]+|\b(?:run|job|tool|receipt|navigation|page)\s+(?:id|ref(?:erence)?)\b|\be\d+\b|\b\w+_\w+\b/i.test(value)) return '';
	if (/\b(?:provider|adapter|gateway|harness|checkpoint|idempotency|stdout|stderr|traceback|exception|json|sql|nonce|endpoint|seccomp|skill|credential|bearer)\b|^(?:terminal|browser|shell|bash|python)\b|exit code|api[_ -]?key|\bsk-[\w-]+|HTTP\s*\d{3}|\b(?:pnpm|npm|python\d*|curl|docker|bash|uv)\s|\$\(|```/i.test(value)) return '';
	return cleanDetail(value);
}

export function publicPlanStepLabel(value: string | undefined): string {
	return publicActivityText(value) || 'Researching';
}

export function publicPlanStepDetail(value: string | undefined): string {
	const detail = cleanDetail(value);
	if (!detail) return '';
	if (/timeout|timed out|interrupted|stream ended early/i.test(detail)) {
		return 'The source check ended before it completed.';
	}
	if (/paywall|subscription|login|captcha|blocked|access denied|forbidden/i.test(detail)) {
		return 'A source could not be read because access was restricted.';
	}
	if (/no usable|no cited sources|no readable|returned no .*sources?|empty source/i.test(detail)) {
		return 'No usable sources were found for this step.';
	}
	if (
		/provider|adapter|gateway|harness|register|configured|credential|api[_ -]?key|http\s*\d{3}|json|stack|traceback|exception/i.test(
			detail
		)
	) {
		return 'This research step is not available.';
	}
	return publicActivityText(detail);
}

export function toolStepDetail(tool: ToolStep): string {
	const intent = toolIntent(tool);
	if (intent?.detail) return publicActivityText(intent.detail);
	// Saved/reconnected calls can contain the original provider payload. Only
	// research queries and source descriptions are public activity details.
	if (isInternalTool(tool.name) || /^(?:browser|read_file|write_file|list_files|list_directory|publish_)/i.test(tool.name)) {
		return '';
	}
	if (!/search|google|bing|duckduckgo|fetch|read|browse|open|http|url|page|verify|check|validate|fact/i.test(tool.name)) return '';

	const argDetail = detailFromArguments(tool.arguments);
	if (argDetail) return argDetail;
	const title = publicActivityText(tool.title);
	if (title) return title;
	const url = tool.url;
	if (url) return prettyUrl(url);
	const explicit = publicActivityText(tool.detail);
	if (explicit && explicit.toLowerCase() !== tool.name.toLowerCase()) return explicit;
	return detailFromResult(tool.result);
}

/** Public outcomes, never command output, file contents or diagnostic payloads. */
export function toolStepResult(tool: ToolStep): string {
	const result = normalizeValue(tool.result);
	if (result && typeof result === 'object' && !Array.isArray(result)) {
		const record = result as Record<string, unknown>;
		const exitCode = numberValue(record.exit_code);
		if (record.error || record.failed === true || (exitCode !== undefined && exitCode !== 0)) return 'This action could not be completed.';
		if (exitCode === 0) return 'Completed.';
		if (/^(?:publish_|write_file)/i.test(tool.name) && (record.workspace_path || numberValue(record.bytes) !== undefined)) return 'File saved.';
		if (/^read_file$/i.test(tool.name)) return 'File read.';
		if (/^browser(?:_|$)/i.test(tool.name)) {
			if (record.reset === true) return 'Browsing session cleared.';
			if (record.screenshot_path || record.screenshot_sha256) return 'Page image saved.';
			if (record.evidence_available === false) return 'Page read; citation evidence is unavailable.';
			return record.url || record.title || record.text ? 'Page read.' : '';
		}
	}
	return detailFromResult(result);
}

export function toolStepSummary(tool: ToolStep, done = false): string {
	const label = toolStepLabel(tool, done);
	const detail = toolStepDetail(tool);
	return detail ? `${label}: ${detail}` : label;
}

export function toolStepLabel(tool: ToolStep, done = false): string {
	const intent = toolIntent(tool);
	if (intent) return done ? intent.done : intent.live;
	return done ? doneLabel(tool.name) : liveLabel(tool.name);
}

export function showToolRawName(_tool: ToolStep): boolean {
	return false;
}

function detailFromArguments(value: unknown): string {
	const normalized = normalizeValue(value);
	if (codeFromArguments(normalized)) return '';

	const query = findString(normalized, ['query', 'q', 'search_query', 'search', 'keywords']);
	if (query) return publicActivityText(query);

	const url = findString(normalized, ['url', 'href', 'link', 'uri']);
	if (url) return prettyUrl(url);

	return '';
}

function detailFromResult(value: unknown): string {
	const normalized = normalizeValue(value);
	if (Array.isArray(normalized)) {
		if (normalized.length === 0) return 'No results';
		return `${normalized.length} ${normalized.length === 1 ? 'result' : 'results'}`;
	}

	if (normalized && typeof normalized === 'object') {
		const record = normalized as Record<string, unknown>;
		const count = numberValue(record.count ?? record.total ?? record.total_count ?? record.num_results);
		if (count !== undefined && Number.isSafeInteger(count) && count >= 0 && count <= 10_000) return `${count} ${count === 1 ? 'result' : 'results'}`;

		const results = record.results ?? record.items ?? record.data;
		if (Array.isArray(results)) {
			if (results.length === 0) return 'No results';
			return `${results.length} ${results.length === 1 ? 'result' : 'results'}`;
		}

	}
	return '';
}

function toolIntent(tool: ToolStep): ToolIntent | null {
	const name = tool.name.toLowerCase();
	const args = normalizeValue(tool.arguments);
	const code = codeFromArguments(args);
	const url = findString(args, ['url', 'href', 'link', 'uri']) || tool.url || '';
	if (name === 'browser') {
		const action = findString(args, ['action']);
		if (action === 'click') return { live: 'Clicking page', done: 'Page clicked', detail: browserTargetDetail(args) };
		if (action === 'navigate') return { live: 'Opening page', done: 'Page opened', detail: url ? prettyUrl(url) : undefined };
		if (['fill', 'type', 'key'].includes(action)) return { live: 'Interacting with page', done: 'Page interaction complete' };
		if (action === 'scroll') return { live: 'Reviewing page', done: 'Page reviewed' };
		if (action === 'screenshot') return { live: 'Saving page image', done: 'Page image saved' };
		if (action === 'reset') return { live: 'Clearing browsing session', done: 'Browsing session cleared' };
		return { live: 'Reading page', done: 'Page read', detail: url ? prettyUrl(url) : undefined };
	}

	if (/skill[_-]?view|view[_-]?skill/.test(name)) {
		return {
			live: 'Preparing research',
			done: 'Research prepared'
		};
	}

	if (/delegate[_-]?task|task[_-]?delegate/.test(name)) {
		return {
			live: 'Checking research',
			done: 'Research checked'
		};
	}

	if (/browser[_-]?click/.test(name)) {
		return {
			live: 'Clicking page',
			done: 'Page click completed',
			detail: browserTargetDetail(args)
		};
	}

	if (/browser[_-]?snapshot/.test(name)) {
		return {
			live: 'Reading source',
			done: 'Source read',
			detail: browserTargetDetail(args)
		};
	}

	if (/browser_navigate|browse|open/.test(name)) {
		if (/informed(opinions|perspectives)\.org/i.test(url)) {
			return {
				live: 'Reading source',
				done: 'Expert database opened',
				detail: prettyUrl(url)
			};
		}
		return url
			? { live: 'Reading source', done: 'Source read', detail: prettyUrl(url) }
			: null;
	}

	if (!isInternalTool(name) || !code) return null;

	return intentFromCode(code);
}

function intentFromCode(code: string): ToolIntent {
	const lower = code.toLowerCase();
	if (lower.includes('duckduckgo') || lower.includes('queries = [')) {
		return { live: 'Scanning coverage', done: 'Coverage scanned',
			detail: listDetail('Queries', extractListStrings(code, 'queries'), 2) };
	}
	if (lower.includes('search-experts.php')) {
		return { live: 'Searching expert database', done: 'Expert database searched',
			detail: listDetail('Terms', extractListStrings(code, 'term'), 4) };
	}
	if (lower.includes('canada.ca') || lower.includes('department-finance')) {
		return { live: 'Checking official pages', done: 'Official pages checked', detail: 'Finance Canada pages' };
	}
	if (/informed(opinions|perspectives)\.org/i.test(code)) {
		return { live: 'Checking expert sources', done: 'Expert sources checked', detail: 'Informed Perspectives' };
	}
	return { live: 'Working with data', done: 'Data processed' };
}

function browserTargetDetail(value: unknown): string | undefined {
	const url = findString(value, ['url', 'href', 'link']);
	return url ? prettyUrl(url) || undefined : undefined;
}

function findString(value: unknown, keys: string[], depth = 0, allowPrimitive = false): string {
	if (depth > 3 || value == null) return '';

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return allowPrimitive ? String(value).trim() : '';
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findString(item, keys, depth + 1, allowPrimitive);
			if (found) return found;
		}
		return '';
	}

	if (typeof value !== 'object') return '';
	const record = value as Record<string, unknown>;
	const lowerKeys = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
	for (const key of keys) {
		const actual = lowerKeys.get(key.toLowerCase());
		if (!actual) continue;
		const found = findString(record[actual], keys, depth + 1, true);
		if (found) return found;
	}

	for (const nested of Object.values(record)) {
		const found = findString(nested, keys, depth + 1, false);
		if (found) return found;
	}

	return '';
}

function normalizeValue(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed || !/^[{[]/.test(trimmed)) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function codeFromArguments(value: unknown): string {
	const normalized = normalizeValue(value);
	if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return '';
	const code = (normalized as Record<string, unknown>).code;
	return typeof code === 'string' ? code : '';
}

function isInternalTool(name: string): boolean {
	return /execute_code|browser[_-]?(navigate|click|snapshot)|terminal|shell|bash|exec|command|python|skill[_-]?view|view[_-]?skill|delegate[_-]?task|task[_-]?delegate/i.test(
		name
	);
}

function extractListStrings(code: string, marker: string): string[] {
	const lower = code.toLowerCase();
	let start = lower.indexOf(`${marker.toLowerCase()} = [`);
	if (start === -1) start = lower.indexOf(`for ${marker.toLowerCase()} in [`);
	if (start === -1) return [];
	const bracketStart = code.indexOf('[', start);
	const bracketEnd = code.indexOf(']', bracketStart);
	if (bracketStart === -1 || bracketEnd === -1) return [];
	return extractQuotedStrings(code.slice(bracketStart, bracketEnd + 1));
}

function extractQuotedStrings(value: string): string[] {
	return [...value.matchAll(/['"]([^'"]{2,})['"]/g)]
		.map((match) => cleanDetail(match[1]))
		.filter(Boolean);
}

function listDetail(label: string, items: string[], limit: number): string {
	const clean = [...new Set(items.map((item) => publicActivityText(item)).filter(Boolean))];
	if (!clean.length) return '';
	const shown = clean.slice(0, limit).join(', ');
	const extra = clean.length > limit ? ` +${clean.length - limit}` : '';
	return cleanDetail(`${label}: ${shown}${extra}`);
}

function cleanDetail(value: unknown): string {
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
	const text = String(value)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
		.replace(/\s+/g, ' ').trim();
	if (!text || DETAIL_NOISE.has(text.toLowerCase())) return '';
	if (text.length <= DETAIL_LIMIT) return text;
	return `${text.slice(0, DETAIL_LIMIT - 3).trimEnd()}...`;
}

function prettyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
		// Source domains remain useful without exposing signed queries, internal
		// document paths, fragments or record identifiers from a saved payload.
		return publicActivityText(parsed.hostname.replace(/^www\./, ''));
	} catch {
		return '';
	}
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}
