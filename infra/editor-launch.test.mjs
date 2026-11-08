import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readSource = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const launch = JSON.parse(readSource('.claude/launch.json'));

test('the default editor launcher uses only the guarded health-only worker and UI entrypoint', () => {
	const local = launch.configurations[0];
	assert.equal(local.name, 'local');
	assert.equal(local.runtimeExecutable, 'sh');
	assert.equal(local.runtimeArgs.length, 2);
	assert.equal(local.runtimeArgs[0], '-c');
	assert.equal(local.runtimeArgs[1], 'export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH" TMPDIR=/private/tmp; exec node scripts/agent-local.mjs start --health-only');
	assert.equal(local.port, 3001);
	assert.doesNotMatch(JSON.stringify(launch), /agent-local-prod|\.env\.local-prod|dev-all\.mjs|NODE_EXTRA_CA_CERTS/);
});

test('health-only mode reaches the worker and returns before startup recovery', () => {
	const guarded = readSource('scripts/agent-local.mjs');
	assert.match(guarded, /healthOnly\s*\?\s*\{\s*NEWSCRAFT_AGENT_HEALTH_ONLY:\s*'1'\s*\}/);
	const worker = readSource('services/agent/src/newscraft_agent/service.py');
	assert.match(worker, /health_only=bool\(_integer_setting\("NEWSCRAFT_AGENT_HEALTH_ONLY", 0, 0, 1\)\)/);
	assert.match(worker, /async def recover_durable_runs\(\) -> None:\s+if settings\.health_only:\s+return\s+app\.state\.recovery_task = asyncio\.create_task/);
	assert.match(worker, /if settings\.health_only and not \(request\.method == "GET" and request\.url\.path == "\/ready"\):\s+return JSONResponse\([^\n]+status_code=503\)/);
});

test('the UI-only editor launcher advertises the port used by the dev command', () => {
	const dev = launch.configurations.find((configuration) => configuration.name === 'dev');
	const manifest = JSON.parse(readSource('package.json'));
	assert.equal(dev.runtimeExecutable, 'pnpm');
	assert.deepEqual(dev.runtimeArgs, ['run', 'dev']);
	assert.equal(dev.port, Number(/--port\s+(\d+)/.exec(manifest.scripts.dev)[1]));
});
