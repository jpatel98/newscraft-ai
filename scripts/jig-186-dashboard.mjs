import { Buffer } from 'node:buffer';
import process from 'node:process';
import { buildJig186DashboardSnapshot } from '../src/lib/server/jig-186-dashboard.ts';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

try {
	let inputText = '';
	let inputBytes = 0;
	for await (const chunk of process.stdin) {
		const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
		inputBytes += Buffer.byteLength(text);
		if (inputBytes > MAX_INPUT_BYTES) throw new RangeError('JIG-186 dashboard input exceeds its byte bound');
		inputText += text;
	}
	const input = JSON.parse(inputText);
	const nowIndex = process.argv.indexOf('--now');
	const now = nowIndex === -1 ? undefined : Number(process.argv[nowIndex + 1]);
	const snapshot = now === undefined
		? buildJig186DashboardSnapshot(input)
		: buildJig186DashboardSnapshot(input, now);
	process.stdout.write(`${JSON.stringify(snapshot)}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : 'invalid dashboard input';
	process.stderr.write(`ERROR: ${message}\n`);
	process.exitCode = 1;
}
