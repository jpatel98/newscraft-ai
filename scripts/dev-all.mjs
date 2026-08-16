#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = resolve(root, 'services/hermes-chat');
loadEnv({ path: resolve(root, '.env.local'), override: false, quiet: true });
loadEnv({ path: resolve(serviceRoot, '.env'), override: false, quiet: true });

const args = new Set(process.argv.slice(2));
const hermesOnly = args.has('--hermes-only');
const uiUrl = 'http://127.0.0.1:3001';
const configuredHermesUrl = (process.env.NEWSCRAFT_HERMES_URL || 'http://127.0.0.1:8000').replace(
	/\/$/,
	''
);
const hermesEndpoint = parseLocalHermesUrl(configuredHermesUrl);
const hermesUrl = hermesEndpoint.origin;
const allPorts = [
	{ name: 'UI', port: 3001, healthUrl: `${uiUrl}/api/health`, kind: 'ui' },
	{ name: 'Hermes', port: hermesEndpoint.port, healthUrl: `${hermesUrl}/ready`, kind: 'hermes' }
];
const activePorts = hermesOnly ? allPorts.slice(1) : allPorts;

if (args.has('--stop')) {
	stopRepoListeners(allPorts);
	process.exit(0);
}

const listeners = getListeners(activePorts);
const occupied = [...listeners.values()].flat();

if (occupied.length > 0) {
	const healthy = await Promise.all(activePorts.map((service) => isHealthy(service)));
	const repoOwned = occupied.every((processInfo) => processInfo.command.includes(root));
	if (repoOwned && healthy.every(Boolean)) {
		console.log('NewsCraft dev is already running.');
		if (!hermesOnly) console.log(`UI:     ${uiUrl}`);
		console.log(`Hermes: ${hermesUrl}`);
		console.log('Use Ctrl-C in the terminal that started it, or run `corepack pnpm dev:stop`.');
		process.exit(0);
	}

	console.error('Cannot start NewsCraft dev because a required local port is occupied.');
	for (const service of activePorts) {
		for (const processInfo of listeners.get(service.port) ?? []) {
			console.error(`- ${service.name} port ${service.port}: PID ${processInfo.pid}, ${processInfo.command}`);
		}
	}
	process.exit(1);
}

try {
	configureHermesEnvironment();
	await startDevServers();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function parseLocalHermesUrl(value) {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('NEWSCRAFT_HERMES_URL must be a valid local HTTP URL.');
	}
	if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
		throw new Error('dev:all starts only a loopback Hermes service. Use HTTPS for a remote VPS service.');
	}
	if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
		throw new Error('NEWSCRAFT_HERMES_URL must not include a path, query, or fragment.');
	}
	return { origin: parsed.origin, port: Number(parsed.port || 80) };
}

function configureHermesEnvironment() {
	const appToken = (process.env.NEWSCRAFT_HERMES_API_TOKEN || '').trim();
	const serviceToken = (process.env.HERMES_AGUI_SESSION_TOKEN || '').trim();
	const token = appToken || serviceToken;
	if (!token) {
		throw new Error(
			'Set NEWSCRAFT_HERMES_API_TOKEN in .env.local and HERMES_AGUI_SESSION_TOKEN in services/hermes-chat/.env.'
		);
	}
	if (appToken && serviceToken && appToken !== serviceToken) {
		throw new Error('The NewsCraft and Hermes session tokens do not match.');
	}
	process.env.NEWSCRAFT_HERMES_URL = hermesUrl;
	process.env.NEWSCRAFT_HERMES_API_TOKEN = token;
	process.env.HERMES_AGUI_SESSION_TOKEN = token;
	process.env.HERMES_AGUI_HOST ||= '127.0.0.1';
	process.env.HERMES_AGUI_PORT ||= String(hermesEndpoint.port);
	if (Number(process.env.HERMES_AGUI_PORT) !== hermesEndpoint.port) {
		throw new Error('HERMES_AGUI_PORT must match NEWSCRAFT_HERMES_URL.');
	}

	const required = [
		'NEWSCRAFT_HERMES_TENANT_SECRET',
		'NEWSCRAFT_HERMES_HOME',
		'NEWSCRAFT_HERMES_WORKSPACE',
		'NEWSCRAFT_HERMES_MODEL_PROVIDER',
		'NEWSCRAFT_HERMES_MODEL',
		'NEWSCRAFT_HERMES_MODEL_BASE_URL',
		'NEWSCRAFT_HERMES_MODEL_API_KEY'
	].filter((name) => !(process.env[name] || '').trim());
	if (required.length) throw new Error(`Hermes local configuration is missing: ${required.join(', ')}`);
}

async function startDevServers() {
	let shuttingDown = false;
	if (!hermesOnly) await buildSharedPackage();

	const rawBinary =
		process.env.NEWSCRAFT_HERMES_BIN || resolve(serviceRoot, '.venv/bin/newscraft-hermes-chat');
	const hermesBinary = isAbsolute(rawBinary) ? rawBinary : resolve(root, rawBinary);
	if (!existsSync(hermesBinary)) {
		throw new Error(
			`Hermes runtime was not found at ${hermesBinary}. Run services/hermes-chat/scripts/install-runtime.sh first.`
		);
	}

	const children = [startProcess('hermes', hermesBinary, [], root)];
	if (!hermesOnly) {
		children.unshift(
			startProcess(
				'ui',
				resolve(root, 'node_modules/.bin/vite'),
				['dev', '--host', '127.0.0.1', '--port', '3001', '--strictPort'],
				root
			)
		);
	}

	const shutdown = (signal = 'SIGTERM') => {
		if (shuttingDown) return;
		shuttingDown = true;
		for (const child of children) killProcessGroup(child, signal);
		setTimeout(() => {
			for (const child of children) killProcessGroup(child, 'SIGKILL');
		}, 5_000).unref();
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	for (const child of children) {
		child.on('exit', (code, signal) => {
			if (shuttingDown || code === 0 || code === 130 || code === 143 || signal) return;
			console.error(`dev:${child.newsCraftName} exited with code ${code}`);
			shutdown();
			process.exitCode = code ?? 1;
		});
	}
	await Promise.all(children.map((child) => once(child, 'exit')));
}

async function buildSharedPackage() {
	console.log('ui: building @newscraft/shared');
	const child = spawn('pnpm', ['--filter', '@newscraft/shared', 'build'], {
		cwd: root,
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	prefixOutput(child.stdout, 'ui');
	prefixOutput(child.stderr, 'ui');
	const [code, signal] = await once(child, 'exit');
	if (code !== 0) throw new Error(`@newscraft/shared build failed${signal ? ` with signal ${signal}` : ''}`);
}

function startProcess(name, command, commandArgs, cwd) {
	const child = spawn(command, commandArgs, {
		cwd,
		detached: process.platform !== 'win32',
		env: process.env,
		stdio: ['inherit', 'pipe', 'pipe']
	});
	child.newsCraftName = name;
	prefixOutput(child.stdout, name);
	prefixOutput(child.stderr, name);
	return child;
}

function prefixOutput(stream, prefix) {
	let pending = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk) => {
		pending += chunk;
		const lines = pending.split(/\r?\n/);
		pending = lines.pop() ?? '';
		for (const line of lines) if (line.length > 0) console.log(`${prefix}: ${line}`);
	});
	stream.on('end', () => {
		if (pending.length > 0) console.log(`${prefix}: ${pending}`);
	});
}

function getListeners(services) {
	const byPort = new Map();
	for (const service of services) {
		const pids = run('lsof', ['-tiTCP:' + service.port, '-sTCP:LISTEN'])
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (pids.length === 0) {
			byPort.set(service.port, []);
			continue;
		}
		const ps = run('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'command=', '-p', pids.join(',')]);
		byPort.set(
			service.port,
			ps
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => {
					const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
					return match
						? { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }
						: { pid: Number.NaN, pgid: Number.NaN, command: line };
				})
		);
	}
	return byPort;
}

function stopRepoListeners(services) {
	const listeners = [...getListeners(services).entries()].flatMap(([port, processes]) =>
		processes
			.filter((processInfo) => processInfo.command.includes(root))
			.map((processInfo) => ({ ...processInfo, port }))
	);
	if (listeners.length === 0) {
		console.log(`No NewsCraft dev listeners found on ports ${services.map((item) => item.port).join(' or ')}.`);
		return;
	}
	const processGroups = new Set(
		listeners
			.map((processInfo) => processInfo.pgid)
			.filter((pgid) => Number.isFinite(pgid) && pgid > 0 && pgid !== process.pid)
	);
	for (const pgid of processGroups) {
		try {
			process.kill(-pgid, 'SIGTERM');
		} catch {
			// The listener can exit before the PID fallback.
		}
	}
	for (const processInfo of listeners) {
		try {
			process.kill(processInfo.pid, 'SIGTERM');
		} catch {
			// The listener can already be stopped.
		}
		console.log(`Stopped NewsCraft listener on port ${processInfo.port}: PID ${processInfo.pid}`);
	}
}

function killProcessGroup(child, signal) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (process.platform === 'win32') child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process can already be stopped.
		}
	}
}

function run(command, commandArgs) {
	const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
	if (result.error || result.status !== 0) return '';
	return result.stdout;
}

async function isHealthy(service) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1_500);
	const token = (process.env.NEWSCRAFT_HERMES_API_TOKEN || process.env.HERMES_AGUI_SESSION_TOKEN || '').trim();
	try {
		const response = await fetch(service.healthUrl, {
			headers:
				service.kind === 'hermes' && token
					? { authorization: `Bearer ${token}`, 'x-hermes-session-token': token }
					: {},
			signal: controller.signal
		});
		const body = await response.json().catch(() => null);
		return response.ok && body?.ok === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}
