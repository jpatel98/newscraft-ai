import { describe, expect, it, vi } from 'vitest';
import { DocumentError } from '$lib/server/documents/errors';
import { classifyCell, formatDecimal, parseCsv, parseDecimal } from './csv';

const encode = (text: string) => new TextEncoder().encode(text);

describe('csv parser', () => {
	it('keeps original cell strings, leading zeros and empty cells, and numbers records from 1', () => {
		const parsed = parseCsv(encode('vendor_id,amount,note\n00123,"1,200.50",\n00124,75,"says ""hi"", twice"\n'));
		expect(parsed.hasHeader).toBe(true);
		expect(parsed.delimiter).toBe(',');
		expect(parsed.columns.map((column) => column.name)).toEqual(['vendor_id', 'amount', 'note']);
		expect(parsed.rows).toEqual([
			{ ordinal: 1, sourceLine: 2, cells: ['00123', '1,200.50', ''] },
			{ ordinal: 2, sourceLine: 3, cells: ['00124', '75', 'says "hi", twice'] }
		]);
		expect(parsed.columns[0].inferredType).toBe('integer');
		expect(parsed.columns[1].inferredType).toBe('decimal');
	});

	it('tracks the physical line of records that span lines and strips a BOM', () => {
		const parsed = parseCsv(encode('﻿name,address\r\nAcme,"1 Main St\nSuite 2"\r\nBeta,"2 Side Rd"\r\n'));
		expect(parsed.rows.map((row) => [row.ordinal, row.sourceLine])).toEqual([[1, 2], [2, 4]]);
		expect(parsed.rows[0].cells[1]).toBe('1 Main St\nSuite 2');
	});

	it('sniffs semicolon and tab delimiters', () => {
		expect(parseCsv(encode('a;b;c\n1;2;3\n')).delimiter).toBe(';');
		expect(parseCsv(encode('a\tb\n1\t2\n')).delimiter).toBe('\t');
	});

	it('generates column names when there is no header and pads ragged rows', () => {
		const parsed = parseCsv(encode('1,2,3\n4,5\n6,7,8\n'));
		expect(parsed.hasHeader).toBe(false);
		expect(parsed.columns.map((column) => column.name)).toEqual(['Column 1', 'Column 2', 'Column 3']);
		expect(parsed.rows[1].cells).toEqual(['4', '5', '']);
		expect(parsed.raggedRows).toBe(1);
	});

	it('rejects non UTF-8 bytes, binary content and unterminated quotes visibly', () => {
		expect(() => parseCsv(new Uint8Array([0x61, 0x2c, 0xff, 0xfe, 0x0a]))).toThrowError(DocumentError);
		expect(() => parseCsv(encode('a,b\n1,\u0000\n'))).toThrow(/binary/);
		expect(() => parseCsv(encode('a,b\n"open,1\n'))).toThrow(/unterminated/);
		expect(() => parseCsv(new Uint8Array())).toThrow(/empty/);
	});

	it('enforces the column ceiling even after the first fifty records', () => {
		const wide = Array.from({ length: 201 }, (_, index) => `c${index}`).join(',');
		expect(() => parseCsv(encode(`${wide}\n${wide}\n`))).toThrow(/columns/);
		expect(() => parseCsv(encode(`id,amount\n${'A,1\n'.repeat(49)}${wide}\n`))).toThrow(/columns/);
	});

	it('stops at streaming limits before reading a malformed suffix', async () => {
		vi.resetModules();
		vi.doMock('./constants', async (importOriginal) => ({
			...await importOriginal<typeof import('./constants')>(),
			MAX_CSV_RECORDS: 2,
			MAX_CSV_COLUMNS: 2,
			MAX_CSV_CELL_CHARS: 4
		}));
		try {
			const { parseCsv: boundedParse } = await import('./csv');
			expect(() => boundedParse(encode('a,b\n1,2\n3,4\n5,6\n"unterminated'))).toThrow(/rows/);
			expect(() => boundedParse(encode('a,b\n1,2,3\n"unterminated'))).toThrow(/columns/);
			expect(() => boundedParse(encode('a\n"12345'))).toThrow(/cell exceeds/);
			expect(boundedParse(encode('a,b\n1,2\n3,4\n')).rows).toHaveLength(2);
			expect(() => boundedParse(encode('1,2\n3,4\n5,6\n'))).toThrow(/rows/);
		} finally {
			vi.doUnmock('./constants');
			vi.resetModules();
		}
	});

	it('preserves fields first encountered after the width sample', () => {
		const parsed = parseCsv(encode(`id,amount\n${'A,1\n'.repeat(49)}B,2,keep-me\n`));
		expect(parsed.columns.map((column) => column.name)).toEqual(['id', 'amount', 'Column 3']);
		expect(parsed.rows.at(-1)?.cells).toEqual(['B', '2', 'keep-me']);
		expect(parsed.rows[0].cells).toEqual(['A', '1', '']);
		expect(parsed.raggedRows).toBe(1);
	});

	it('does not validate cells against incorrect candidate delimiters', () => {
		const cells = ['x'.repeat(6000), 'y'.repeat(6000)];
		expect(parseCsv(encode(`a,b\n${cells.join(',')}\n`)).rows[0].cells).toEqual(cells);
	});

	it('ignores unfinished sample records without ignoring malformed source records', () => {
		const cell = 'x'.repeat(9000);
		expect(parseCsv(encode(`name\n${`"${cell}"\n`.repeat(8)}`)).rows).toHaveLength(8);
		expect(() => parseCsv(encode('name\n"unfinished'))).toThrow(/unterminated/);
	});

	it('classifies cells and parses decimals exactly', () => {
		expect(classifyCell('2024-03-01')).toBe('date');
		expect(classifyCell('$1,250.75')).toBe('decimal');
		expect(classifyCell('ACME')).toBe('text');
		expect(parseDecimal('$1,250.75')).toEqual({ units: 125075n, scale: 2 });
		expect(parseDecimal('-3')).toEqual({ units: -3n, scale: 0 });
		expect(parseDecimal('twelve')).toBeNull();
		for (const malformed of ['1,,000', '12,34', '1,234,', '1,2.3', '$1,,000']) {
			expect(parseDecimal(malformed)).toBeNull();
		}
		expect(parseDecimal('1,234,567.89')).toEqual({ units: 123456789n, scale: 2 });
		expect(formatDecimal(125075n, 2)).toBe('1250.75');
		expect(formatDecimal(-5n, 2)).toBe('-0.05');
	});
});
