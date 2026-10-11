// Local UI + worker against the Contabo database; private values live in .env.local-prod.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLocalSetup } from './agent-local.mjs';

const root = resolve(import.meta.dirname, '..');
const overrides = Object.fromEntries(
	readFileSync(resolve(root, '.env.local-prod'), 'utf8')
		.split('\n')
		.filter(line => /^[A-Z_]+=/.test(line))
		.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
);
if (!overrides.DATABASE_URL) throw new Error('.env.local-prod must define DATABASE_URL');
const { environment } = resolveLocalSetup({ root, provider: 'deepseek' });
const child = spawn(process.execPath, [resolve(root, 'scripts/dev-all.mjs')], {
	cwd: root,
	env: {
		...environment,
		NEWSCRAFT_AGENT_MAX_INPUT_TOKENS: '600000',
		NEWSCRAFT_AGENT_MAX_COST_USD: '0.50',
		NEWSCRAFT_AGENT_MAX_STEPS: '20',
		NEWSCRAFT_AGENT_MAX_SECONDS: '300',
		NEWSCRAFT_AGENT_MAX_SEARCH_CALLS: '15',
		...overrides
	},
	stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
