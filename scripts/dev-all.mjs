#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiUrl = 'http://127.0.0.1:3001';
const harnessUrl = 'http://127.0.0.1:8650';
const ports = [
	{ name: 'UI', port: 3001, healthUrl: `${uiUrl}/api/health` },
	{ name: 'harness', port: 8650, healthUrl: `${harnessUrl}/health` }
];

const args = new Set(process.argv.slice(2));

if (args.has('--stop')) {
	stopRepoListeners();
	process.exit(0);
}

const listeners = getListeners();
const occupied = [...listeners.values()].flat();

if (occupied.length > 0) {
	const healthy = await Promise.all(ports.map((service) => isHealthy(service.healthUrl)));
	const repoOwned = occupied.every((processInfo) => processInfo.command.includes(root));
	if (repoOwned && healthy.every(Boolean)) {
		console.log('NewsCraft dev is already running.');
		console.log(`UI:      ${uiUrl}`);
		console.log(`Harness: ${harnessUrl}`);
		console.log('Use Ctrl-C in the terminal that started it, or run `corepack pnpm dev:stop`.');
		process.exit(0);
	}

	console.error('Cannot start NewsCraft dev because one of its local ports is already occupied.');
	for (const service of ports) {
		const processes = listeners.get(service.port) ?? [];
		for (const processInfo of processes) {
			console.error(
				`- ${service.name} port ${service.port}: PID ${processInfo.pid}, ${processInfo.command}`
			);
		}
	}
	console.error('If these are stale NewsCraft processes, run `corepack pnpm dev:stop` and retry.');
	process.exit(1);
}

try {
	await startDevServers();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

async function startDevServers() {
	let shuttingDown = false;
	await buildSharedPackage();

	const children = [
		startProcess(
			'ui',
			resolve(root, 'node_modules/.bin/vite'),
			['dev', '--host', '127.0.0.1', '--port', '3001', '--strictPort'],
			root
		),
		startProcess(
			'harness',
			resolve(root, 'services/newsroom-harness/node_modules/.bin/tsx'),
			['watch', 'src/index.ts'],
			resolve(root, 'services/newsroom-harness')
		)
	];

	const shutdown = (signal = 'SIGTERM') => {
		if (shuttingDown) return;
		shuttingDown = true;
		for (const child of children) {
			killProcessGroup(child, signal);
		}

		setTimeout(() => {
			for (const child of children) {
				killProcessGroup(child, 'SIGKILL');
			}
		}, 5_000).unref();
	};

	process.on('SIGINT', () => {
		shutdown('SIGINT');
	});
	process.on('SIGTERM', () => {
		shutdown('SIGTERM');
	});

	for (const child of children) {
		child.on('exit', (code, signal) => {
			if (shuttingDown) return;
			if (code === 0 || code === 130 || code === 143 || signal) return;
			console.error(`dev:${child.newsCraftName} exited with code ${code}`);
			shutdown();
			process.exitCode = code ?? 1;
		});
	}

	await Promise.all(children.map((child) => once(child, 'exit')));
}

async function buildSharedPackage() {
	console.log('harness: building @newscraft/shared');
	const child = spawn('pnpm', ['--filter', '@newscraft/shared', 'build'], {
		cwd: root,
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	prefixOutput(child.stdout, 'harness');
	prefixOutput(child.stderr, 'harness');

	const [code, signal] = await once(child, 'exit');
	if (code !== 0) {
		throw new Error(`@newscraft/shared build failed${signal ? ` with signal ${signal}` : ''}`);
	}
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
		for (const line of lines) {
			if (line.length > 0) console.log(`${prefix}: ${line}`);
		}
	});
	stream.on('end', () => {
		if (pending.length > 0) console.log(`${prefix}: ${pending}`);
	});
}

function getListeners() {
	const byPort = new Map();
	for (const service of ports) {
		const pids = run('lsof', ['-tiTCP:' + service.port, '-sTCP:LISTEN'])
			.trim()
			.split(/\s+/)
			.filter(Boolean);

		if (pids.length === 0) {
			byPort.set(service.port, []);
			continue;
		}

		const ps = run('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'command=', '-p', pids.join(',')]);
		const processes = ps
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
				return match
					? { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }
					: { pid: Number.NaN, pgid: Number.NaN, command: line };
			});
		byPort.set(service.port, processes);
	}
	return byPort;
}

function stopRepoListeners() {
	const listeners = [...getListeners().entries()].flatMap(([port, processes]) =>
		processes
			.filter((processInfo) => processInfo.command.includes(root))
			.map((processInfo) => ({ ...processInfo, port }))
	);

	if (listeners.length === 0) {
		console.log('No NewsCraft dev listeners found on ports 3001 or 8650.');
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
			// The listener may already have exited. The PID fallback below handles stragglers.
		}
	}

	for (const processInfo of listeners) {
		try {
			process.kill(processInfo.pid, 'SIGTERM');
		} catch {
			// Ignore already-exited listeners.
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
			// Ignore already-exited children.
		}
	}
}

function run(command, commandArgs) {
	const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
	if (result.error || result.status !== 0) return '';
	return result.stdout;
}

async function isHealthy(url) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1_500);
	try {
		const response = await fetch(url, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}
