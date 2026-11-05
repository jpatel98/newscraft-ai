import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pythonCandidates, selectPython } from './test-agent.mjs';

const OWNED = resolve(import.meta.dirname, '../services/agent/.venv-owned/bin/python');

test('an explicit interpreter is the only candidate, so a bad one cannot fall through', () => {
	const candidates = pythonCandidates({ NEWSCRAFT_AGENT_PYTHON: '/opt/py/bin/python' }, () => true);
	assert.deepEqual(candidates.map((c) => c.command), ['/opt/py/bin/python']);
	const selected = selectPython({ NEWSCRAFT_AGENT_PYTHON: '/opt/py/bin/python' }, () => ({ ok: false, reason: 'not found' }), () => true);
	assert.equal(selected.command, null);
	assert.match(selected.failures[0], /NEWSCRAFT_AGENT_PYTHON.*not found/);
});

test('owned venv is preferred, then python3.11, and only existing venvs are tried', () => {
	const order = pythonCandidates({}, (path) => path === OWNED).map((c) => c.command);
	assert.deepEqual(order, [OWNED, 'python3.11']);
	assert.deepEqual(pythonCandidates({}, () => false).map((c) => c.command), ['python3.11']);
});

test('a candidate missing worker dependencies is rejected and the next one is used', () => {
	const probed = [];
	const selected = selectPython({}, (command) => {
		probed.push(command);
		return command === OWNED ? { ok: false, reason: "ModuleNotFoundError: No module named 'fastapi'" } : { ok: true };
	}, (path) => path === OWNED);
	assert.deepEqual(probed, [OWNED, 'python3.11']);
	assert.equal(selected.command, 'python3.11');
	assert.match(selected.failures[0], /fastapi/);
});

test('nothing usable yields no command rather than a silent pass', () => {
	assert.equal(selectPython({}, () => ({ ok: false, reason: 'not found' }), () => false).command, null);
});

test('the CLI returns a failed worker suite status instead of passing', (t) => {
	const directory = mkdtempSync(resolve(tmpdir(), 'newscraft-test-runner-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const interpreter = resolve(directory, 'fixture-python');
	writeFileSync(interpreter, `#!${process.execPath}\nprocess.exit(process.argv[2] === '-I' ? 0 : 7);\n`, { mode: 0o700 });
	const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'test-agent.mjs')], {
		env: { ...process.env, NEWSCRAFT_AGENT_PYTHON: interpreter }, encoding: 'utf8'
	});
	assert.equal(result.status, 7, result.stderr);
});
