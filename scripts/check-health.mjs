#!/usr/bin/env node
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const url = args.url || process.env.HEALTH_URL;
const expectKind = args.expect || process.env.HEALTH_EXPECT || 'generic';
const retries = intValue(args.retries || process.env.HEALTH_RETRIES, 30);
const delayMs = intValue(args.delayMs || process.env.HEALTH_DELAY_MS, 1000);
const timeoutMs = intValue(args.timeoutMs || process.env.HEALTH_TIMEOUT_MS, 3000);

if (!url) {
	console.error('Usage: node scripts/check-health.mjs --url <url> [--expect ui|agent|generic]');
	process.exit(2);
}

let lastError = '';
for (let attempt = 1; attempt <= retries; attempt += 1) {
	const result = await probe(url, { timeoutMs, headers: healthHeaders(expectKind) });
	if (result.ok && expectedShapeOk(result.body, expectKind)) {
		console.log(`OK: ${expectKind} health is ready`);
		process.exit(0);
	}
	lastError = result.error || explainFailure(result.body, expectKind) || `HTTP ${result.status}`;
	if (attempt < retries) await delay(delayMs);
}

console.error(`ERROR: ${expectKind} health did not become ready. ${lastError}`);
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
		const httpReady = response.ok;
		const bodyReady = body?.ok === true;
		const statusBodyMatch = httpReady === bodyReady;
		return {
			ok: httpReady && bodyReady && statusBodyMatch,
			status: response.status,
			body,
			error: !statusBodyMatch
				? 'health HTTP status and body readiness disagree'
				: response.ok
					? ''
					: `HTTP ${response.status}`
		};
	} catch {
		return {
			ok: false,
			status: 0,
			body: null,
			error: 'health probe did not respond'
		};
	}
}

function expectedShapeOk(body, kind) {
	if (!body || body.ok !== true) return false;
	if (kind !== 'generic' && !['ready', 'degraded'].includes(body.state)) return false;
	if (kind === 'agent' || kind === 'hermes') {
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const capabilities = body.capabilities || {};
		return (
			body.service === 'newscraft-agent' &&
			typeof body.processInstanceId === 'string' &&
			/^[a-f0-9]{32}$/.test(body.processInstanceId) &&
			body.toolset === 'newscraft-agent' &&
			body.runtime?.orchestration === 'newscraft' &&
			body.runtime?.endpointMode === 'explicit' &&
			['publish_markdown', 'publish_csv'].every((tool) => tools.includes(tool)) &&
			capabilities.standard === true &&
			capabilities.files === true &&
			capabilities.boundedLoop?.configured === true &&
			capabilities.boundedLoop?.cancellation === true &&
			capabilities.boundedLoop?.stepBudget === true &&
			capabilities.boundedLoop?.timeBudget === true &&
			capabilities.accountIsolation?.ownedRunState === true &&
			capabilities.durableRuns?.configured === true &&
			capabilities.durableRuns?.callback === true &&
			capabilities.accountIsolation?.tenantHeader === 'x-newscraft-tenant-key' &&
			capabilities.accountIsolation?.conversationWorkspace === true
		);
	}
	if (kind === 'ui') {
		if (body.service !== 'newscraft-ui') return false;
		const hasPrivateDetails = body.app !== undefined || body.gateway !== undefined;
		return (
			!hasPrivateDetails ||
			(body.app?.ok === true &&
				body.gateway?.ok === true &&
				body.components?.database?.ok === true &&
				(body.components?.agent || body.components?.hermes)?.ok === true)
		);
	}
	return true;
}

function healthHeaders(kind) {
	if (!['agent', 'hermes'].includes(kind)) return {};
	const token = (
		process.env.NEWSCRAFT_AGENT_API_TOKEN || process.env.NEWSCRAFT_HERMES_API_TOKEN || process.env.NEWSCRAFT_AGENT_SESSION_TOKEN || ''
	).trim();
	if (!token) return {};
	return { authorization: `Bearer ${token}` };
}

function explainFailure(body, kind) {
	if (!body) return '';
	if (body.ok !== true) return 'health returned not ready';
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
