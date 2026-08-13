#!/usr/bin/env node
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const url = args.url || process.env.HEALTH_URL;
const expectKind = args.expect || process.env.HEALTH_EXPECT || 'generic';
const retries = intValue(args.retries || process.env.HEALTH_RETRIES, 30);
const delayMs = intValue(args.delayMs || process.env.HEALTH_DELAY_MS, 1000);
const timeoutMs = intValue(args.timeoutMs || process.env.HEALTH_TIMEOUT_MS, 3000);

if (!url) {
	console.error('Usage: node scripts/check-health.mjs --url <url> [--expect ui|hermes|generic]');
	process.exit(2);
}

let lastError = '';
for (let attempt = 1; attempt <= retries; attempt += 1) {
	const result = await probe(url, { timeoutMs, headers: healthHeaders(expectKind) });
	if (result.ok && expectedShapeOk(result.body, expectKind)) {
		console.log(`OK: ${expectKind} health is ready at ${url}`);
		process.exit(0);
	}
	lastError = result.error || explainFailure(result.body, expectKind) || `HTTP ${result.status}`;
	if (attempt < retries) await delay(delayMs);
}

console.error(`ERROR: ${expectKind} health did not become ready at ${url}. ${lastError}`);
process.exit(1);

function parseArgs(values) {
	const parsed = {};
	for (let i = 0; i < values.length; i += 1) {
		const value = values[i];
		if (!value.startsWith('--')) continue;
		const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		const next = values[i + 1];
		if (next && !next.startsWith('--')) {
			parsed[key] = next;
			i += 1;
		} else {
			parsed[key] = 'true';
		}
	}
	return parsed;
}

function intValue(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

async function probe(target, options) {
	try {
		const response = await fetch(target, {
			headers: { accept: 'application/json', ...options.headers },
			signal: AbortSignal.timeout(options.timeoutMs)
		});
		const text = await response.text();
		const body = safeJson(text);
		return {
			ok: response.ok && body?.ok === true,
			status: response.status,
			body,
			error: response.ok ? '' : `HTTP ${response.status}: ${text.slice(0, 300)}`
		};
	} catch (err) {
		return {
			ok: false,
			status: 0,
			body: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

function expectedShapeOk(body, kind) {
	if (!body || body.ok !== true) return false;
	if (kind === 'hermes') {
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const capabilities = body.capabilities || {};
		return (
			body.service === 'newscraft-hermes-chat' &&
			body.toolset === 'hermes-acp' &&
			body.runtime?.endpointMode === 'explicit' &&
			tools.includes('browser_navigate') &&
			tools.includes('browser_snapshot') &&
			capabilities.standard === true &&
			capabilities.browser === true &&
			capabilities.webResearch === true &&
			capabilities.terminal === true &&
			capabilities.files === true &&
			capabilities.codeExecution === true &&
			capabilities.delegation === true &&
			capabilities.skills === true &&
			capabilities.memory === true
		);
	}
	if (kind === 'ui') {
		if (body.service !== 'newscraft-ui') return false;
		const hasPrivateDetails = body.app !== undefined || body.gateway !== undefined;
		return !hasPrivateDetails || (body.app?.ok === true && body.gateway?.ok === true);
	}
	return true;
}

function healthHeaders(kind) {
	if (kind !== 'hermes') return {};
	const token = (
		process.env.NEWSCRAFT_HERMES_API_TOKEN || process.env.HERMES_AGUI_SESSION_TOKEN || ''
	).trim();
	if (!token) return {};
	return { authorization: `Bearer ${token}`, 'x-hermes-session-token': token };
}

function explainFailure(body, kind) {
	if (!body) return '';
	if (body.ok !== true) return body.error || body.gateway?.body || body.app?.error || 'health returned ok:false';
	if (!expectedShapeOk(body, kind)) return `health JSON did not match expected ${kind} shape`;
	return '';
}

function safeJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
