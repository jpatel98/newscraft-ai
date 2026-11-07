// Local UI + worker against the Contabo database; private values live in .env.local-prod.
import { spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalSetup } from './agent-local.mjs';

const ROOT = resolve(import.meta.dirname, '..');

export async function runLocalProd({ root = ROOT, resolveSetup = resolveLocalSetup, readFile = readFileSync, spawn = spawnProcess, write = line => console.error(line) } = {}) {
	try {
		const { report, environment } = resolveSetup({ root, provider: 'deepseek' });
		if (report?.ok !== true || !environment || typeof environment !== 'object' || Array.isArray(environment)) {
			write('Production helper blocked: local setup checks must pass before applying production overrides.');
			return 1;
		}
		const overrides = Object.fromEntries(
			readFile(resolve(root, '.env.local-prod'), 'utf8')
				.split('\n')
				.filter(line => /^[A-Z_]+=/.test(line))
				.map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()])
		);
		if (!overrides.DATABASE_URL) {
			write('.env.local-prod must define DATABASE_URL');
			return 1;
		}
		const child = spawn(process.execPath, [resolve(root, 'scripts/dev-all.mjs')], {
			cwd: root,
			env: {
				...environment,
				NEWSCRAFT_AGENT_MAX_INPUT_TOKENS: '600000',
				NEWSCRAFT_AGENT_MAX_COST_USD: '0.50',
				NEWSCRAFT_AGENT_MAX_STEPS: '20',
				NEWSCRAFT_AGENT_MAX_SECONDS: '300',
				NEWSCRAFT_AGENT_MAX_SEARCH_CALLS: '15',
				NEWSCRAFT_AGENT_MAX_OUTPUT_TOKENS: '8192',
				...overrides
			},
			stdio: 'inherit'
		});
		const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
		process.on('SIGINT', interrupt);
		process.on('SIGTERM', terminate);
		try {
			const [code] = await once(child, 'exit');
			return Number.isInteger(code) ? code : 1;
		} finally {
			process.off('SIGINT', interrupt);
			process.off('SIGTERM', terminate);
		}
	} catch {
		write('Production helper failed; no exception or environment values were printed.');
		return 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await runLocalProd();
}
