import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function writeEvalReport(name: 'report.json' | 'copy-report.json', report: unknown): string | undefined {
	const directory = process.env.LEDGER_EVAL_REPORT_DIR?.trim();
	if (!directory) return;
	const destination = resolve(directory, name);
	mkdirSync(resolve(directory), { recursive: true });
	writeFileSync(destination, JSON.stringify(report, null, 1) + '\n');
	return destination;
}
