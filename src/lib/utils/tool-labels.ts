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
	{ test: /assignment[_-]?desk/i, label: { live: 'Planning request', done: 'Request routed' } },
	{ test: /skill[_-]?view|view[_-]?skill/i, label: { live: 'Loading skill', done: 'Skill loaded' } },
	{
		test: /delegate[_-]?task|task[_-]?delegate/i,
		label: { live: 'Starting helper task', done: 'Helper task finished' }
	},
	{ test: /search|google|bing|duckduckgo|web/i, label: { live: 'Scanning coverage', done: 'Coverage scanned' } },
	{ test: /fetch|read|browse|open|http|url|page/i, label: { live: 'Reading source', done: 'Source read' } },
	{ test: /verify|check|validate|fact/i, label: { live: 'Checking facts', done: 'Facts checked' } },
	{ test: /summari[sz]e|brief|outline/i, label: { live: 'Summarizing', done: 'Summary ready' } },
	{ test: /draft|write|compose/i, label: { live: 'Drafting', done: 'Draft ready' } },
	{ test: /terminal|shell|bash|exec|command/i, label: { live: 'Running internal check', done: 'Internal check finished' } },
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

export function toolStepDetail(tool: ToolStep): string {
	const explicit = cleanDetail(tool.detail);
	if (explicit && explicit.toLowerCase() !== tool.name.toLowerCase()) return explicit;

	const intent = toolIntent(tool);
	if (intent?.detail) return intent.detail;

	const title = cleanDetail(tool.title);
	if (title) return title;

	const url = cleanDetail(tool.url);
	if (url) return prettyUrl(url);

	const argDetail = detailFromArguments(tool.arguments);
	if (argDetail) return argDetail;

	const resultDetail = detailFromResult(tool.result);
	if (resultDetail) return resultDetail;

	return '';
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

export function showToolRawName(tool: ToolStep): boolean {
	return !isInternalTool(tool.name) && !/[_:-]/.test(tool.name);
}

function detailFromArguments(value: unknown): string {
	const normalized = normalizeValue(value);
	if (codeFromArguments(normalized)) return '';

	const command = findString(normalized, ['command', 'cmd', 'shell', 'script']);
	if (command) return cleanDetail(command);

	const query = findString(normalized, ['query', 'q', 'search_query', 'search', 'keywords']);
	if (query) return cleanDetail(query);

	const url = findString(normalized, ['url', 'href', 'link', 'uri']);
	if (url) return prettyUrl(url);

	const sql = findString(normalized, ['sql', 'statement']);
	if (sql) return `SQL: ${sql}`;

	const path = findString(normalized, ['path', 'file', 'filename', 'filepath']);
	if (path) return `File: ${path}`;

	const task = findString(normalized, ['task', 'instruction', 'prompt']);
	if (task) return `Task: ${task}`;

	if (typeof normalized === 'string') return cleanDetail(normalized);
	return '';
}

function detailFromResult(value: unknown): string {
	const normalized = normalizeValue(value);
	const output = resultOutput(normalized);
	if (output) {
		const summary = summarizeOutput(output);
		if (summary) return summary;
	}

	if (Array.isArray(normalized)) {
		if (normalized.length === 0) return 'No results';
		return `${normalized.length} ${normalized.length === 1 ? 'result' : 'results'}`;
	}

	if (normalized && typeof normalized === 'object') {
		const record = normalized as Record<string, unknown>;
		const count = numberValue(record.count ?? record.total ?? record.total_count ?? record.num_results);
		if (count !== undefined) return `${count} ${count === 1 ? 'result' : 'results'}`;

		const results = record.results ?? record.items ?? record.data;
		if (Array.isArray(results)) {
			if (results.length === 0) return 'No results';
			return `${results.length} ${results.length === 1 ? 'result' : 'results'}`;
		}

		const text = findString(value, ['summary', 'message', 'title', 'detail']);
		if (text) return text;
	}

	if (typeof normalized === 'string') return cleanDetail(normalized);
	return '';
}

function toolIntent(tool: ToolStep): ToolIntent | null {
	const name = tool.name.toLowerCase();
	const args = normalizeValue(tool.arguments);
	const code = codeFromArguments(args);
	const url = findString(args, ['url', 'href', 'link', 'uri']) || tool.url || '';

	if (/skill[_-]?view|view[_-]?skill/.test(name)) {
		return {
			live: 'Loading skill',
			done: 'Skill loaded',
			detail: skillDetail(args)
		};
	}

	if (/delegate[_-]?task|task[_-]?delegate/.test(name)) {
		return {
			live: 'Starting helper task',
			done: 'Helper task finished',
			detail: delegateDetail(args)
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

	return intentFromCode(code, tool.result);
}

function intentFromCode(code: string, result: unknown): ToolIntent {
	const lower = code.toLowerCase();
	const output = resultOutput(normalizeValue(result));
	const hasTimeout = output ? /timed out|timeout/i.test(output) : false;
	const hasParserError = output ? /modulenotfounderror|traceback/i.test(output) : false;

	if (lower.includes('duckduckgo') || lower.includes('queries = [')) {
		return {
			live: 'Scanning coverage',
			done: 'Coverage scanned',
			detail: listDetail('Queries', extractListStrings(code, 'queries'), 2)
		};
	}

	if (lower.includes('search-experts.php')) {
		return {
			live: 'Searching expert database',
			done: 'Expert database searched',
			detail: listDetail('Terms', extractListStrings(code, 'term'), 4)
		};
	}

	if (lower.includes('experts-api.js') && lower.includes('$.ajax')) {
		return {
			live: 'Finding expert search endpoint',
			done: 'Expert search endpoint found',
			detail: 'Informed Perspectives AJAX endpoint'
		};
	}

	if (lower.includes('experts-api.js') && lower.includes('loadexperts')) {
		return {
			live: 'Inspecting search flow',
			done: 'Search flow inspected',
			detail: 'Informed Perspectives loadExperts flow'
		};
	}

	if (lower.includes('experts-api.js')) {
		return {
			live: 'Reading search script',
			done: 'Search script read',
			detail: 'Informed Perspectives expert-search JavaScript'
		};
	}

	if (lower.includes('canada.ca') || lower.includes('department-finance')) {
		return {
			live: 'Checking official pages',
			done: 'Official pages checked',
			detail: hasTimeout ? 'Finance Canada pages timed out' : 'Finance Canada pages'
		};
	}

	if (lower.includes('experts_api_data')) {
		return {
			live: 'Reading API config',
			done: 'API config read',
			detail: 'Expert database nonce and endpoint'
		};
	}

	if (lower.includes('database-of-experts')) {
		return {
			live: hasParserError ? 'Trying page parser' : 'Reading expert database',
			done: hasParserError ? 'Page parser tried' : 'Expert database read',
			detail: hasParserError
				? 'Parser unavailable; continued with another method'
				: 'Informed Perspectives expert database'
		};
	}

	if (lower.includes('candidates={')) {
		return {
			live: 'Checking candidate profiles',
			done: 'Candidate profiles checked',
			detail: listDetail('Candidates', extractObjectKeys(code), 4)
		};
	}

	if (lower.includes('emails') && lower.includes('urls={')) {
		return {
			live: 'Checking contact details',
			done: 'Contact details checked',
			detail: listDetail('Profiles', extractObjectKeys(code), 4)
		};
	}

	if (lower.includes('emails') || lower.includes('profile')) {
		return {
			live: 'Checking profiles',
			done: 'Profiles checked',
			detail: output ? summarizeOutput(output) || undefined : undefined
		};
	}

	if (/informed(opinions|perspectives)\.org/i.test(code)) {
		return {
			live: 'Checking expert site',
			done: 'Expert site checked',
			detail: output ? summarizeOutput(output) || 'Informed Perspectives pages' : 'Informed Perspectives pages'
		};
	}

	return {
		live: 'Running internal check',
		done: 'Internal check finished',
		detail: output ? summarizeOutput(output) || undefined : undefined
	};
}

function skillDetail(value: unknown): string | undefined {
	const skill = findString(value, [
		'skill',
		'skill_name',
		'skillname',
		'skill_id',
		'skillid',
		'name',
		'id',
		'path'
	]);
	if (skill) return `Skill: ${skill}`;
	const primitive = primitiveString(value);
	return primitive ? `Skill: ${primitive}` : undefined;
}

function delegateDetail(value: unknown): string | undefined {
	const task = findString(value, ['task', 'instruction', 'prompt', 'description']);
	if (task) return `Task: ${task}`;
	const primitive = primitiveString(value);
	return primitive ? `Task: ${primitive}` : undefined;
}

function browserTargetDetail(value: unknown): string | undefined {
	const target = findString(value, ['url', 'href', 'link', 'selector', 'ref', 'element', 'text']);
	return target ? cleanDetail(target) : undefined;
}

function primitiveString(value: unknown): string {
	const normalized = normalizeValue(value);
	return typeof normalized === 'string' ? cleanDetail(normalized) : '';
}

function findString(value: unknown, keys: string[], depth = 0, allowPrimitive = false): string {
	if (depth > 3 || value == null) return '';

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return allowPrimitive ? cleanDetail(value) : '';
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

function resultOutput(value: unknown): string {
	const normalized = normalizeValue(value);
	if (Array.isArray(normalized)) {
		for (const item of normalized) {
			const found = resultOutput(item);
			if (found) return found;
		}
		return '';
	}
	if (!normalized || typeof normalized !== 'object') return typeof normalized === 'string' ? normalized : '';
	const record = normalized as Record<string, unknown>;
	const text = record.text ?? record.output ?? record.message ?? record.error;
	if (typeof text === 'string') {
		const parsed = normalizeValue(text);
		if (parsed !== text) return resultOutput(parsed);
		return text;
	}
	return '';
}

function summarizeOutput(output: string): string {
	const unfolded = output.replace(/\\n/g, '\n');
	const text = unfolded.replace(/\s+/g, ' ').trim();
	if (!text) return '';
	if (/modulenotfounderror|traceback/i.test(text)) return 'Fallback parser failed; continued';
	if (/timed out|timeout/i.test(text)) return 'Request timed out';

	const names = [...unfolded.matchAll(/^###\s+(.+?)\s*$/gm)]
		.map((match) => cleanDetail(match[1]))
		.filter(Boolean);
	if (names.length) return listDetail('Profiles', names, 4);

	const terms = [...unfolded.matchAll(/TERM\s+(.+?)\s+status/gi)]
		.map((match) => cleanDetail(match[1]))
		.filter(Boolean);
	if (terms.length) return listDetail('Terms', terms, 4);

	const urls = [...unfolded.matchAll(/URL\s+(?:\d+\s+)?(https?:\/\/\S+)/gi)]
		.map((match) => prettyUrl(match[1]))
		.filter(Boolean);
	if (urls.length) return listDetail('Pages', urls, 3);

	if (/emails?\s*\[/i.test(unfolded)) return 'Contact emails found';
	if (/"success"\s*:\s*true/i.test(unfolded) && /experts?/i.test(unfolded)) return 'Expert records returned';
	if (/<html|<!doctype/i.test(unfolded)) return '';
	return cleanDetail(text);
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

function extractObjectKeys(code: string): string[] {
	const match = code.match(/\b(?:candidates|urls)\s*=\s*\{([\s\S]*?)\n\}/);
	if (!match) return [];
	return [...match[1].matchAll(/['"]([^'"]+)['"]\s*:/g)].map((entry) => cleanDetail(entry[1]));
}

function extractQuotedStrings(value: string): string[] {
	return [...value.matchAll(/['"]([^'"]{2,})['"]/g)]
		.map((match) => cleanDetail(match[1]))
		.filter(Boolean);
}

function listDetail(label: string, items: string[], limit: number): string {
	const clean = [...new Set(items.map((item) => cleanDetail(item)).filter(Boolean))];
	if (!clean.length) return '';
	const shown = clean.slice(0, limit).join(', ');
	const extra = clean.length > limit ? ` +${clean.length - limit}` : '';
	return `${label}: ${shown}${extra}`;
}

function cleanDetail(value: unknown): string {
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return '';
	const text = String(value).replace(/\s+/g, ' ').trim();
	if (!text || DETAIL_NOISE.has(text.toLowerCase())) return '';
	if (text.length <= DETAIL_LIMIT) return text;
	return `${text.slice(0, DETAIL_LIMIT - 3).trimEnd()}...`;
}

function prettyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
		return cleanDetail(`${parsed.hostname.replace(/^www\./, '')}${path}`);
	} catch {
		return cleanDetail(url);
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
