import { MAX_CSV_CELL_CHARS, MAX_CSV_COLUMNS, MAX_CSV_RECORDS } from './constants';
import { DocumentError } from '$lib/server/documents/errors';
import type { CsvColumnType, DatasetColumn, DatasetRow } from './types';

export interface ParsedCsv {
	delimiter: string;
	hasHeader: boolean;
	encoding: 'utf-8';
	columns: DatasetColumn[];
	rows: DatasetRow[];
	/** Records whose field count did not match the header or inferred width. */
	raggedRows: number;
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const;
const INTEGER_RE = /^[-+]?\d{1,18}$/;
const DECIMAL_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;
const CURRENCY_RE = /^[-+]?[$€£]\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;
const SLASH_DATE_RE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;

/**
 * Decode and parse a CSV into original cell strings. Nothing is coerced: numbers
 * keep their leading zeros, empty cells stay empty strings, and each record
 * remembers the physical line it started on so a citation can point back at
 * the raw bytes. Only UTF-8 is accepted; other encodings fail visibly rather
 * than being guessed.
 */
export function parseCsv(bytes: Uint8Array): ParsedCsv {
	if (bytes.byteLength === 0) throw new DocumentError(422, 'empty_csv', 'The CSV file is empty.');
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new DocumentError(422, 'unsupported_encoding', 'The CSV must be UTF-8 encoded.');
	}
	if (text.includes('\u0000')) throw new DocumentError(422, 'binary_csv', 'The file contains binary data, not CSV text.');
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
	const delimiter = sniffDelimiter(text);
	const records = tokenize(text, delimiter);
	if (records.length === 0) throw new DocumentError(422, 'empty_csv', 'The CSV file has no records.');
	const width = records.reduce((maximum, record) => Math.max(maximum, record.cells.length), 0);
	const hasHeader = detectHeader(records);
	const dataRecords = hasHeader ? records.slice(1) : records;
	if (dataRecords.length > MAX_CSV_RECORDS) {
		throw new DocumentError(413, 'too_many_rows', `CSVs must have ${MAX_CSV_RECORDS.toLocaleString('en-US')} rows or fewer.`);
	}
	const headerNames = hasHeader ? records[0].cells : [];
	const names = Array.from({ length: width }, (_, index) => {
		const raw = (headerNames[index] ?? '').trim();
		return raw || `Column ${index + 1}`;
	});
	let raggedRows = 0;
	const expectedWidth = hasHeader ? headerNames.length : width;
	const rows: DatasetRow[] = dataRecords.map((record, index) => {
		let cells = record.cells;
		if (cells.length !== expectedWidth) raggedRows += 1;
		if (cells.length < width) cells = [...cells, ...Array(width - cells.length).fill('')];
		return { ordinal: index + 1, sourceLine: record.line, cells };
	});
	const columns = names.map((name, index) => describeColumn(uniqueName(name, names, index), index, rows));
	return { delimiter, hasHeader, encoding: 'utf-8', columns, rows, raggedRows };
}

function uniqueName(name: string, names: string[], index: number): string {
	const earlier = names.slice(0, index).filter((other) => other === name).length;
	return earlier === 0 ? name : `${name} (${earlier + 1})`;
}

function sniffDelimiter(text: string): string {
	let best = ',';
	let bestScore = -1;
	for (const delimiter of CANDIDATE_DELIMITERS) {
		const counts = sampleColumnCounts(text, delimiter);
		if (counts.length === 0) continue;
		const first = counts[0];
		if (first < 2) continue;
		const consistent = counts.filter((count) => count === first).length;
		const score = consistent * 1000 + first;
		if (score > bestScore) {
			bestScore = score;
			best = delimiter;
		}
	}
	return best;
}

function sampleColumnCounts(text: string, delimiter: string): number[] {
	const counts: number[] = [];
	const end = Math.min(text.length, 64 * 1024);
	let columns = 1;
	let quoted = false;
	let cellStarted = false;
	for (let index = 0; index < end; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') index += 1;
				else quoted = false;
			}
		} else if (char === '"' && !cellStarted) {
			quoted = true;
			cellStarted = true;
		} else if (char === delimiter) {
			columns += 1;
			cellStarted = false;
		} else if (char === '\r' || char === '\n') {
			if (columns > 1 || cellStarted) counts.push(columns);
			if (counts.length === 20) return counts;
			if (char === '\r' && text[index + 1] === '\n') index += 1;
			columns = 1;
			cellStarted = false;
		} else {
			cellStarted = true;
		}
	}
	if (end === text.length && !quoted && (columns > 1 || cellStarted)) counts.push(columns);
	return counts;
}

interface RawRecord {
	line: number;
	cells: string[];
}

function tokenize(text: string, delimiter: string): RawRecord[] {
	const records: RawRecord[] = [];
	let cells: string[] = [];
	let cell = '';
	let quoted = false;
	let line = 1;
	let recordLine = 1;
	let cellStarted = false;
	const append = (char: string) => {
		if (cell.length >= MAX_CSV_CELL_CHARS) {
			throw new DocumentError(413, 'cell_too_long', `A CSV cell exceeds ${MAX_CSV_CELL_CHARS.toLocaleString('en-US')} characters.`);
		}
		cell += char;
	};
	const pushCell = () => {
		if (cells.length >= MAX_CSV_COLUMNS) {
			throw new DocumentError(413, 'too_many_columns', `CSVs must have ${MAX_CSV_COLUMNS} columns or fewer.`);
		}
		cells.push(cell);
		cell = '';
		cellStarted = false;
	};
	const pushRecord = () => {
		pushCell();
		const blank = cells.length === 1 && cells[0] === '';
		if (!blank) {
			if (records.length >= MAX_CSV_RECORDS + 1) {
				throw new DocumentError(413, 'too_many_rows', `CSVs must have ${MAX_CSV_RECORDS.toLocaleString('en-US')} rows or fewer.`);
			}
			records.push({ line: recordLine, cells });
		}
		cells = [];
		recordLine = line;
	};
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					append('"');
					index += 1;
				} else {
					quoted = false;
				}
			} else {
				if (char === '\n') line += 1;
				append(char);
			}
			continue;
		}
		if (char === '"' && !cellStarted) {
			quoted = true;
			cellStarted = true;
			continue;
		}
		if (char === delimiter) {
			pushCell();
			if (cells.length >= MAX_CSV_COLUMNS) {
				throw new DocumentError(413, 'too_many_columns', `CSVs must have ${MAX_CSV_COLUMNS} columns or fewer.`);
			}
			continue;
		}
		if (char === '\r') {
			if (text[index + 1] === '\n') index += 1;
			line += 1;
			pushRecord();
			continue;
		}
		if (char === '\n') {
			line += 1;
			pushRecord();
			continue;
		}
		append(char);
		cellStarted = true;
	}
	if (quoted) throw new DocumentError(422, 'malformed_csv', 'The CSV has an unterminated quoted field.');
	if (cell.length > 0 || cells.length > 0) pushRecord();
	return records;
}

function detectHeader(records: RawRecord[]): boolean {
	const first = records[0].cells;
	if (first.some((cell) => cell.trim() === '')) return false;
	if (first.some((cell) => classifyCell(cell) !== 'text')) return false;
	if (records.length === 1) return true;
	const second = records[1].cells;
	if (second.some((cell) => ['integer', 'decimal', 'date'].includes(classifyCell(cell)))) return true;
	// All-text data: a header is still likely when the first row's values are
	// unique and short, like column labels tend to be.
	return new Set(first.map((cell) => cell.trim().toLowerCase())).size === first.length && first.every((cell) => cell.length <= 64);
}

export function classifyCell(value: string): Exclude<CsvColumnType, 'mixed'> {
	const trimmed = value.trim();
	if (trimmed === '') return 'empty';
	if (INTEGER_RE.test(trimmed)) return 'integer';
	if ((DECIMAL_RE.test(trimmed) && /\d/.test(trimmed)) || CURRENCY_RE.test(trimmed)) return 'decimal';
	if (ISO_DATE_RE.test(trimmed) || SLASH_DATE_RE.test(trimmed)) return 'date';
	return 'text';
}

function describeColumn(name: string, index: number, rows: DatasetRow[]): DatasetColumn {
	const tally: Record<string, number> = {};
	const distinct = new Set<string>();
	let nonEmpty = 0;
	for (const row of rows) {
		const cell = row.cells[index] ?? '';
		const type = classifyCell(cell);
		if (type !== 'empty') {
			nonEmpty += 1;
			distinct.add(cell.trim().toLowerCase());
		}
		tally[type] = (tally[type] ?? 0) + 1;
	}
	return {
		id: `c${index + 1}`,
		name,
		inferredType: inferType(tally, nonEmpty),
		nonEmptyCount: nonEmpty,
		distinctCount: distinct.size
	};
}

function inferType(tally: Record<string, number>, nonEmpty: number): CsvColumnType {
	if (nonEmpty === 0) return 'empty';
	const share = (type: string) => (tally[type] ?? 0) / nonEmpty;
	if (share('integer') >= 0.95) return 'integer';
	if (share('integer') + share('decimal') >= 0.95) return 'decimal';
	if (share('date') >= 0.95) return 'date';
	if (share('text') >= 0.95) return 'text';
	return 'mixed';
}

/**
 * Exact decimal parsing for amounts: returns the value scaled to an integer
 * number of minor units plus the scale, so sums never go through floating
 * point. Returns null for anything that is not a plain or currency-prefixed
 * number.
 */
export function parseDecimal(value: string): { units: bigint; scale: number } | null {
	const original = value.trim();
	if (!((DECIMAL_RE.test(original) && /\d/.test(original)) || CURRENCY_RE.test(original))) return null;
	const trimmed = original.replace(/^([-+]?)[$€£]\s?/, '$1').replace(/,/g, '');
	const negative = trimmed.startsWith('-');
	const unsigned = trimmed.replace(/^[-+]/, '');
	const [whole, fraction = ''] = unsigned.split('.');
	if (fraction.length > 9 || whole.length > 18) return null;
	const units = BigInt(`${whole || '0'}${fraction}`);
	return { units: negative ? -units : units, scale: fraction.length };
}

export function formatDecimal(units: bigint, scale: number): string {
	const negative = units < 0n;
	const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
	const whole = digits.slice(0, digits.length - scale) || '0';
	const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
	return `${negative ? '-' : ''}${whole}${fraction}`;
}
