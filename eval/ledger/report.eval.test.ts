import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeEvalReport } from './report';

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe('opt-in eval reports', () => {
	it.each([undefined, '', '   '])('performs no filesystem writes without a report directory (%s)', (directory) => {
		vi.stubEnv('LEDGER_EVAL_REPORT_DIR', directory);
		expect(writeEvalReport('report.json', { synthetic: true })).toBeUndefined();
		expect(writeEvalReport('copy-report.json', { synthetic: true })).toBeUndefined();
		expect(mkdirSync).not.toHaveBeenCalled();
		expect(writeFileSync).not.toHaveBeenCalled();
	});

	it('writes both reports only inside an explicitly selected directory', () => {
		const root = mkdtempSync(join(tmpdir(), 'ledger-report-test-'));
		temporaryDirectories.push(root);
		const directory = join(root, 'reports');
		vi.stubEnv('LEDGER_EVAL_REPORT_DIR', directory);
		for (const name of ['report.json', 'copy-report.json'] as const) {
			const report = { name, synthetic: true };
			expect(writeEvalReport(name, report)).toBe(join(directory, name));
			expect(JSON.parse(readFileSync(join(directory, name), 'utf8'))).toEqual(report);
		}
		expect(writeFileSync).toHaveBeenCalledTimes(2);
	});

	it('routes both eval reports through the opt-in writer', () => {
		for (const [source, name] of [['ledger.eval.test.ts', 'report.json'], ['copy.eval.test.ts', 'copy-report.json']]) {
			const contents = readFileSync(new URL(source, import.meta.url), 'utf8');
			expect(contents).toContain(`writeEvalReport('${name}', report)`);
			expect(contents).not.toMatch(/writeFileSync\([^\n]*report\.json/);
		}
	});
});
