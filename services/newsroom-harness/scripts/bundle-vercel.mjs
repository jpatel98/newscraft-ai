import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
	bundle: true,
	entryPoints: [resolve(serviceRoot, 'api/index.js')],
	external: ['better-sqlite3'],
	format: 'esm',
	logLevel: 'info',
	outfile: resolve(serviceRoot, 'api/vercel-entry.js'),
	platform: 'node',
	sourcemap: false,
	target: 'node24'
});
