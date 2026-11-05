#!/usr/bin/env node
// Offline unittest run for the owned Python worker (services/agent). Same
// invocation as the CI `worker` job. Reads no env files and contacts no service.
//
// Interpreter, first match wins:
//   1. NEWSCRAFT_AGENT_PYTHON (explicit; never falls through if it is unusable)
//   2. services/agent/.venv-owned/bin/python  (local owned venv)
//   3. services/agent/.venv/bin/python        (`uv sync`, as CI does)
//   4. python3.11 on PATH
// A missing interpreter or missing worker dependency fails the run; worker tests
// are never skipped.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceRoot = resolve(root, 'services/agent');
const REQUIRED_MODULES = ['fastapi', 'httpx', 'ddgs', 'uvicorn'];
const GUIDANCE = [
	'Create the locked worker environment without touching an existing one:',
	'  services/agent/scripts/install-runtime.sh /path/to/venv   (then NEWSCRAFT_AGENT_PYTHON=/path/to/venv/bin/python)',
	'  or: cd services/agent && uv sync --frozen                  (creates services/agent/.venv)'
].join('\n');

// Ordered interpreter candidates; `explicit` ones are not skipped when absent.
export function pythonCandidates(env = process.env, exists = existsSync) {
	if (env.NEWSCRAFT_AGENT_PYTHON) {
		return [{ command: resolve(env.NEWSCRAFT_AGENT_PYTHON), source: 'NEWSCRAFT_AGENT_PYTHON', explicit: true }];
	}
	const candidates = [];
	for (const venv of ['.venv-owned', '.venv']) {
		const command = resolve(serviceRoot, venv, 'bin/python');
		if (exists(command)) candidates.push({ command, source: `services/agent/${venv}` });
	}
	candidates.push({ command: 'python3.11', source: 'python3.11 on PATH' });
	return candidates;
}

function probe(command) {
	const code = [
		'import sys',
		'assert sys.version_info[:2] == (3, 11), "need CPython 3.11, found %d.%d" % sys.version_info[:2]',
		...REQUIRED_MODULES.map((name) => `import ${name}`)
	].join('\n');
	const result = spawnSync(command, ['-I', '-c', code], { encoding: 'utf8' });
	if (result.error) return { ok: false, reason: result.error.code === 'ENOENT' ? 'not found' : result.error.message };
	if (result.status !== 0) return { ok: false, reason: (result.stderr.trim().split('\n').pop() || `exit ${result.status}`) };
	return { ok: true };
}

export function selectPython(env = process.env, run = probe, exists = existsSync) {
	const failures = [];
	for (const candidate of pythonCandidates(env, exists)) {
		const outcome = run(candidate.command);
		if (outcome.ok) return { ...candidate, failures };
		failures.push(`${candidate.source} (${candidate.command}): ${outcome.reason}`);
	}
	return { command: null, failures };
}

function main() {
	const selected = selectPython();
	if (!selected.command) {
		console.error('No usable Python 3.11 for the worker tests (needs ' + REQUIRED_MODULES.join(', ') + ').');
		for (const failure of selected.failures) console.error(`- ${failure}`);
		console.error(GUIDANCE);
		process.exit(1);
	}
	console.log(`Worker tests: ${selected.source}`);
	const pythonPath = [resolve(serviceRoot, 'src'), resolve(serviceRoot, 'tests')];
	if (process.env.PYTHONPATH) pythonPath.push(process.env.PYTHONPATH);
	const result = spawnSync(
		selected.command,
		['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', ...process.argv.slice(2)],
		{ cwd: serviceRoot, stdio: 'inherit', env: { ...process.env, TMPDIR: realpathSync(tmpdir()), PYTHONPATH: pythonPath.join(delimiter) } }
	);
	process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
