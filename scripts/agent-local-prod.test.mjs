import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

const ROOT = '/synthetic/repo';
const SECRET = 'synthetic-private-value';
const PROFILE = `DATABASE_URL=synthetic-production-target\nNEWSCRAFT_AGENT_MAX_STEPS=21\n`;

async function importHelper(context) {
	const originalRead = fs.readFileSync;
	let profileReads = 0;
	const read = context.mock.method(fs, 'readFileSync', (path, ...args) => {
		if (/(^|\/)\.env(?:[./]|$)/.test(String(path))) {
			profileReads += 1;
			throw new Error('Profile reads are forbidden during import');
		}
		return originalRead(path, ...args);
	});
	const spawn = context.mock.method(childProcess, 'spawn', () => assert.fail('Import must not spawn'));
	syncBuiltinESMExports();
	try {
		const helper = await import('./agent-local-prod.mjs');
		assert.equal(profileReads, 0);
		assert.equal(spawn.mock.callCount(), 0);
		return helper;
	} finally {
		read.mock.restore();
		spawn.mock.restore();
		syncBuiltinESMExports();
	}
}

function options(overrides = {}) {
	return {
		root: ROOT,
		resolveSetup: () => ({ report: { ok: true }, environment: { PATH: '/synthetic/bin' } }),
		readFile: () => PROFILE,
		spawn: () => assert.fail('Must not spawn'),
		write() {},
		...overrides
	};
}

test('importing the production helper neither reads profiles nor spawns', async context => {
	const { runLocalProd } = await importHelper(context);
	assert.equal(typeof runLocalProd, 'function');
});

test('failed or missing setup guards block before reading overrides or spawning', async context => {
	const { runLocalProd } = await importHelper(context);
	for (const setup of [
		{ report: { ok: false }, environment: null },
		{ report: { ok: false }, environment: { DATABASE_URL: SECRET } },
		{ report: { ok: true }, environment: null },
		{ report: { ok: true } },
		{ report: { ok: 'true' }, environment: {} },
		{ report: { ok: true }, environment: [] },
		{ environment: {} }
	]) {
		const output = [];
		const readFile = context.mock.fn(() => PROFILE);
		const spawn = context.mock.fn();
		assert.equal(await runLocalProd(options({
			resolveSetup(input) {
				assert.deepEqual(input, { root: ROOT, provider: 'deepseek' });
				return setup;
			},
			readFile,
			spawn,
			write: line => output.push(line)
		})), 1);
		assert.equal(readFile.mock.callCount(), 0);
		assert.equal(spawn.mock.callCount(), 0);
		assert.deepEqual(output, ['Production helper blocked: local setup checks must pass before applying production overrides.']);
		assert.ok(!output.join('\n').includes(SECRET));
	}
});

test('setup exceptions fail closed without reading overrides or printing exception contents', async context => {
	const { runLocalProd } = await importHelper(context);
	const output = [];
	const readFile = context.mock.fn(() => PROFILE);
	const spawn = context.mock.fn();
	assert.equal(await runLocalProd(options({
		resolveSetup() { throw new Error(SECRET); },
		readFile,
		spawn,
		write: line => output.push(line)
	})), 1);
	assert.equal(readFile.mock.callCount(), 0);
	assert.equal(spawn.mock.callCount(), 0);
	assert.deepEqual(output, ['Production helper failed; no exception or environment values were printed.']);
});

test('missing database override and unreadable profiles fail before spawning', async context => {
	const { runLocalProd } = await importHelper(context);
	for (const readFile of [() => 'NEWSCRAFT_AGENT_MAX_STEPS=21\n', () => { throw new Error(SECRET); }]) {
		const output = [];
		const spawn = context.mock.fn();
		assert.equal(await runLocalProd(options({ readFile, spawn, write: line => output.push(line) })), 1);
		assert.equal(spawn.mock.callCount(), 0);
		assert.equal(output.length, 1);
		assert.ok(!output.join('\n').includes(SECRET));
	}
});

test('successful guards preserve the explicit production overrides and local launch target', async context => {
	const { runLocalProd } = await importHelper(context);
	const environment = { PATH: '/synthetic/bin', DATABASE_URL: 'synthetic-guarded-target', NEWSCRAFT_AGENT_MODEL_PROVIDER: 'deepseek' };
	const original = { ...environment };
	const signals = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
	let launches = 0;
	assert.equal(await runLocalProd(options({
		resolveSetup: () => ({ report: { ok: true }, environment }),
		readFile(path, encoding) {
			assert.equal(path, `${ROOT}/.env.local-prod`);
			assert.equal(encoding, 'utf8');
			return PROFILE;
		},
		spawn(command, args, settings) {
			launches += 1;
			assert.equal(command, process.execPath);
			assert.deepEqual(args, [`${ROOT}/scripts/dev-all.mjs`]);
			assert.deepEqual(settings, {
				cwd: ROOT,
				stdio: 'inherit',
				env: {
					...environment,
					DATABASE_URL: 'synthetic-production-target',
					NEWSCRAFT_AGENT_MAX_INPUT_TOKENS: '600000',
					NEWSCRAFT_AGENT_MAX_COST_USD: '0.50',
					NEWSCRAFT_AGENT_MAX_STEPS: '21',
					NEWSCRAFT_AGENT_MAX_SECONDS: '300',
					NEWSCRAFT_AGENT_MAX_SEARCH_CALLS: '15',
					NEWSCRAFT_AGENT_MAX_OUTPUT_TOKENS: '8192'
				}
			});
			const child = new EventEmitter();
			queueMicrotask(() => child.emit('exit', 7));
			return child;
		}
	})), 7);
	assert.equal(launches, 1);
	assert.deepEqual(environment, original);
	assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signals);
});

test('child errors are redacted and signal handlers are removed', async context => {
	const { runLocalProd } = await importHelper(context);
	const output = [];
	const signals = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
	assert.equal(await runLocalProd(options({
		spawn() {
			const child = new EventEmitter();
			queueMicrotask(() => child.emit('error', new Error(SECRET)));
			return child;
		},
		write: line => output.push(line)
	})), 1);
	assert.deepEqual(output, ['Production helper failed; no exception or environment values were printed.']);
	assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signals);
});
