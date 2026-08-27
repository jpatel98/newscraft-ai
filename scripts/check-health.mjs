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
	if (kind === 'hermes') {
		const tools = Array.isArray(body.tools) ? body.tools : [];
		const capabilities = body.capabilities || {};
		const requiredTools = [
			'terminal',
			'process',
			'read_file',
			'write_file',
			'patch',
			'execute_code',
			'delegate_task',
			'skills_list',
			'skill_view',
			'skill_manage',
			'memory',
			'cronjob'
		];
		return (
			body.service === 'newscraft-hermes-chat' &&
			typeof body.processInstanceId === 'string' &&
			/^[a-f0-9]{32}$/.test(body.processInstanceId) &&
			body.toolset === 'hermes-acp' &&
			body.runtime?.endpointMode === 'explicit' &&
			requiredTools.every((tool) => tools.includes(tool)) &&
			capabilities.standard === true &&
			capabilities.terminal === true &&
			capabilities.files === true &&
			capabilities.codeExecution === true &&
			capabilities.delegation === true &&
			capabilities.skills === true &&
			capabilities.memory === true &&
			capabilities.scheduledJobs === true &&
			capabilities.durableRuns?.configured === true &&
			capabilities.durableRuns?.callback === true &&
			capabilities.accountIsolation?.tenantHeader === 'x-newscraft-tenant-key' &&
			capabilities.accountIsolation?.contextLocalHome === true &&
			capabilities.accountIsolation?.stableTaskKey === true &&
			capabilities.accountIsolation?.persistentDockerWorkspace === true &&
			capabilities.accountIsolation?.isolatedBrowserProfiles === true
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
				body.components?.hermes?.ok === true)
		);
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
