#!/usr/bin/env node
// Default/check never read credential contents or contact a provider.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (Number(process.versions.node.split('.')[0]) !== 24) {
	console.error('Use the approved Node 24 runtime for this acceptance command.');
	process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, 'services/hermes-chat/.venv-owned/bin/python');
const child = spawn(python, ['-m', 'hermes_chat.deepseek_acceptance', ...process.argv.slice(2)], {
	cwd: root,
	stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
	console.error('The locked owned Python environment could not start. No fallback runtime was selected.');
	process.exitCode = 1;
});
child.on('exit', (code, signal) => {
	process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
