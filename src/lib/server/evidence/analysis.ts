import { createHash } from 'node:crypto';
import { formatDecimal, parseDecimal } from './csv';
import { ANALYZER_VERSION, MAX_LEADS_PER_RUN } from './constants';
import type { DatasetColumn, DatasetRow, EvidenceRowRef, FindingCalculation, FindingEvidence } from './types';

export interface AnalysisDataset {
	documentId: string;
	name: string;
	sha256: string;
	columns: DatasetColumn[];
	rows: DatasetRow[];
	rejectedRows: number;
}

export interface AnalysisDocument {
	documentId: string;
	name: string;
	sha256: string;
	pages: Array<{ pageNumber: number; text: string }>;
}

export interface ProposedFinding {
	kind: string;
	/** Leads are ranked 1..N; summaries carry rank 0 and are never counted as leads. */
	rank: number;
	isLead: boolean;
	title: string;
	claim: string;
	evidence: FindingEvidence[];
	calculation: FindingCalculation;
	limitations: string;
	nextQuestion: string;
	fingerprint: string;
}

const ID_COLUMN_RE = /\b(?:id|ids|identifier|number|num|no\.?|code|ref(?:erence)?|invoice|vendor|supplier|account|licen[cs]e|permit|case|contract|po|bn|cra)\b/i;
const AMOUNT_COLUMN_RE = /\b(?:amount|amt|total|value|cost|price|paid|payment|fee|fees|sum|spend|budget|expense|salary|revenue|gross|net|balance)\b/i;
const COMPANION_RE = /\b(?:address|addr|street|city|postal|zip|name|phone|email|contact)\b/i;
const MAX_EXAMPLE_ROWS = 8;
const MAX_IDENTIFIER_SCAN = 4000;

/**
 * Deterministic, inspectable analysis over sealed project evidence. No model is
 * called. Every finding names the exact rows, columns and pages behind it and
 * states the rule that produced the number, so a reporter can reproduce it.
 */
export function analyzeEvidence(input: { datasets: AnalysisDataset[]; documents: AnalysisDocument[] }): ProposedFinding[] {
	const datasets = [...input.datasets].sort((a, b) => a.documentId.localeCompare(b.documentId));
	const documents = [...input.documents].sort((a, b) => a.documentId.localeCompare(b.documentId));
	const summaries = datasets.map(datasetSummary);
	const candidates: Array<ProposedFinding & { score: number }> = [];
	for (let a = 0; a < datasets.length; a += 1) {
		for (let b = a + 1; b < datasets.length; b += 1) {
			const join = candidateJoin(datasets[a], datasets[b]);
			if (join) candidates.push(join);
		}
	}
	for (const dataset of datasets) {
		for (const document of documents) {
			const mentions = identifierMentions(dataset, document);
			if (mentions) candidates.push(mentions);
		}
		for (const finding of duplicateIdentifiers(dataset)) candidates.push(finding);
		for (const finding of amountOutliers(dataset)) candidates.push(finding);
	}
	candidates.sort((x, y) => y.score - x.score || x.fingerprint.localeCompare(y.fingerprint));
	const leads = candidates.slice(0, MAX_LEADS_PER_RUN).map((candidate, index) => {
		const { score: _score, ...finding } = candidate;
		return { ...finding, rank: index + 1, isLead: true };
	});
	return [...leads, ...summaries];
}

function fingerprint(parts: unknown[]): string {
	return createHash('sha256').update(JSON.stringify([ANALYZER_VERSION, ...parts])).digest('hex').slice(0, 40);
}

function norm(value: string): string {
	return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cellMap(dataset: AnalysisDataset, row: DatasetRow, columnIds: string[]): Record<string, string> {
	const cells: Record<string, string> = {};
	for (const column of dataset.columns) {
		if (columnIds.includes(column.id)) cells[column.id] = row.cells[columnIndex(dataset, column.id)] ?? '';
	}
	return cells;
}

function columnIndex(dataset: AnalysisDataset, columnId: string): number {
	return dataset.columns.findIndex((column) => column.id === columnId);
}

function columnNames(dataset: AnalysisDataset, columnIds: string[]): string[] {
	return columnIds.map((id) => dataset.columns.find((column) => column.id === id)?.name ?? id);
}

function rowRefs(dataset: AnalysisDataset, rows: DatasetRow[], columnIds: string[]): EvidenceRowRef[] {
	return rows.slice(0, MAX_EXAMPLE_ROWS).map((row) => ({ ordinal: row.ordinal, cells: cellMap(dataset, row, columnIds) }));
}

/** Header words, so `vendor_id` and `Vendor-ID` both expose the token `id`. */
function headerWords(name: string): string {
	return name.replace(/[_\-./]+/g, ' ');
}

function isIdentifierColumn(column: DatasetColumn, rowCount: number): boolean {
	if (column.nonEmptyCount < 2) return false;
	if (ID_COLUMN_RE.test(headerWords(column.name))) return column.inferredType !== 'decimal' && column.inferredType !== 'date';
	return column.inferredType === 'text' && rowCount >= 10 && column.distinctCount / column.nonEmptyCount >= 0.8;
}

function datasetSummary(dataset: AnalysisDataset): ProposedFinding {
	const columns = dataset.columns.map((column) => `${column.name}: ${column.inferredType}, ${column.nonEmptyCount} filled, ${column.distinctCount} distinct`);
	const emptyColumns = dataset.columns.filter((column) => column.inferredType === 'empty').map((column) => column.name);
	const mixed = dataset.columns.filter((column) => column.inferredType === 'mixed').map((column) => column.name);
	const notes: string[] = [];
	if (dataset.rejectedRows > 0) notes.push(`${dataset.rejectedRows} rows had a different number of fields than the header and were padded or truncated.`);
	if (emptyColumns.length) notes.push(`Empty columns: ${emptyColumns.join(', ')}.`);
	if (mixed.length) notes.push(`Mixed-type columns (check before calculating): ${mixed.join(', ')}.`);
	return {
		kind: 'dataset_summary',
		rank: 0,
		isLead: false,
		title: `${dataset.name}: ${dataset.rows.length.toLocaleString('en-US')} rows, ${dataset.columns.length} columns`,
		claim: `The file parses as ${dataset.rows.length.toLocaleString('en-US')} records with ${dataset.columns.length} columns. ${columns.join('; ')}.`,
		evidence: [{ documentId: dataset.documentId, documentName: dataset.name, sha256: dataset.sha256, kind: 'rows', columnIds: dataset.columns.map((column) => column.id), columnNames: dataset.columns.map((column) => column.name), rows: rowRefs(dataset, dataset.rows.slice(0, 3), dataset.columns.map((column) => column.id)) }],
		calculation: {
			method: 'Column types inferred from cell patterns (95% threshold); distinct counts are case-insensitive after trimming.',
			parameters: { columns: dataset.columns.map((column) => column.name) },
			counts: { rows: dataset.rows.length, columns: dataset.columns.length, rejectedRows: dataset.rejectedRows }
		},
		limitations: notes.join(' ') || 'Types are inferred, not declared by the source. Dates are not normalized.',
		nextQuestion: 'Which columns identify a person, vendor or case, and which hold amounts you would report?',
		fingerprint: fingerprint(['dataset_summary', dataset.sha256])
	};
}

/** One card per dataset: the identifier column with the most repeated values. */
function duplicateIdentifiers(dataset: AnalysisDataset): Array<ProposedFinding & { score: number }> {
	const candidates = duplicateIdentifierCandidates(dataset);
	if (candidates.length === 0) return [];
	candidates.sort((a, b) => b.calculation.counts.repeatedValues - a.calculation.counts.repeatedValues || a.fingerprint.localeCompare(b.fingerprint));
	return [candidates[0]];
}

function duplicateIdentifierCandidates(dataset: AnalysisDataset): Array<ProposedFinding & { score: number }> {
	const findings: Array<ProposedFinding & { score: number }> = [];
	for (const column of dataset.columns) {
		if (!isIdentifierColumn(column, dataset.rows.length)) continue;
		const index = columnIndex(dataset, column.id);
		const groups = new Map<string, DatasetRow[]>();
		for (const row of dataset.rows) {
			const key = norm(row.cells[index] ?? '');
			if (!key) continue;
			const group = groups.get(key);
			if (group) group.push(row);
			else groups.set(key, [row]);
		}
		const repeated = Array.from(groups.entries()).filter(([, rows]) => rows.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
		if (repeated.length === 0) continue;
		const duplicateRows = repeated.reduce((sum, [, rows]) => sum + rows.length, 0);
		const examples = repeated.slice(0, 3);
		const companion = dataset.columns.filter((other) => other.id !== column.id && COMPANION_RE.test(headerWords(other.name))).slice(0, 2).map((other) => other.id);
		const columnIds = [column.id, ...companion];
		findings.push({
			kind: 'duplicate_identifiers',
			rank: 0,
			isLead: true,
			score: 20 + Math.min(30, repeated.length),
			title: `${column.name} repeats ${repeated.length} value${repeated.length === 1 ? '' : 's'} in ${dataset.name}`,
			claim: `${repeated.length} distinct ${column.name} value${repeated.length === 1 ? '' : 's'} appear more than once across ${duplicateRows} rows of ${dataset.name}. Most repeated: ${examples.map(([key, rows]) => `"${rows[0].cells[index].trim()}" (${rows.length} rows)`).join(', ')}.`,
			evidence: examples.map(([, rows]) => ({ documentId: dataset.documentId, documentName: dataset.name, sha256: dataset.sha256, kind: 'rows' as const, columnIds, columnNames: columnNames(dataset, columnIds), rows: rowRefs(dataset, rows, columnIds) })),
			calculation: {
				method: 'Exact match on the trimmed, case-insensitive cell value; empty cells ignored.',
				parameters: { column: column.name },
				counts: { rows: dataset.rows.length, nonEmpty: column.nonEmptyCount, repeatedValues: repeated.length, rowsInRepeats: duplicateRows }
			},
			limitations: 'A repeated identifier can be legitimate (several payments to one vendor). This shows where repeats are, not that anything is wrong.',
			nextQuestion: `Should ${column.name} be unique in this source? If so, which rows explain the repeats?`,
			fingerprint: fingerprint(['duplicate_identifiers', dataset.sha256, column.id])
		});
	}
	return findings;
}

function candidateJoin(left: AnalysisDataset, right: AnalysisDataset): (ProposedFinding & { score: number }) | null {
	let best: { leftColumn: DatasetColumn; rightColumn: DatasetColumn; shared: string[]; smaller: number } | null = null;
	for (const leftColumn of left.columns) {
		if (!isIdentifierColumn(leftColumn, left.rows.length)) continue;
		const leftIndex = columnIndex(left, leftColumn.id);
		const leftValues = new Set(left.rows.map((row) => norm(row.cells[leftIndex] ?? '')).filter(Boolean));
		for (const rightColumn of right.columns) {
			if (!isIdentifierColumn(rightColumn, right.rows.length)) continue;
			const rightIndex = columnIndex(right, rightColumn.id);
			const rightValues = new Set(right.rows.map((row) => norm(row.cells[rightIndex] ?? '')).filter(Boolean));
			const shared = Array.from(leftValues).filter((value) => rightValues.has(value)).sort();
			const smaller = Math.min(leftValues.size, rightValues.size);
			if (shared.length < 3 || shared.length / smaller < 0.1) continue;
			if (!best || shared.length > best.shared.length) best = { leftColumn, rightColumn, shared, smaller };
		}
	}
	if (!best) return null;
	const leftIndex = columnIndex(left, best.leftColumn.id);
	const rightIndex = columnIndex(right, best.rightColumn.id);
	// Companion columns with the same header on both sides: count keys whose
	// values disagree (the "three have differing addresses" card).
	const companions = left.columns.filter((column) => column.id !== best!.leftColumn.id && right.columns.some((other) => norm(other.name) === norm(column.name)));
	const disagreements: Array<{ key: string; column: string; leftRow: DatasetRow; rightRow: DatasetRow }> = [];
	const leftByKey = new Map<string, DatasetRow>();
	for (const row of left.rows) {
		const key = norm(row.cells[leftIndex] ?? '');
		if (key && !leftByKey.has(key)) leftByKey.set(key, row);
	}
	const rightByKey = new Map<string, DatasetRow>();
	for (const row of right.rows) {
		const key = norm(row.cells[rightIndex] ?? '');
		if (key && !rightByKey.has(key)) rightByKey.set(key, row);
	}
	for (const key of best.shared) {
		const leftRow = leftByKey.get(key);
		const rightRow = rightByKey.get(key);
		if (!leftRow || !rightRow) continue;
		for (const column of companions) {
			const rightColumn = right.columns.find((other) => norm(other.name) === norm(column.name))!;
			const leftValue = norm(leftRow.cells[columnIndex(left, column.id)] ?? '');
			const rightValue = norm(rightRow.cells[columnIndex(right, rightColumn.id)] ?? '');
			if (leftValue && rightValue && leftValue !== rightValue) disagreements.push({ key, column: column.name, leftRow, rightRow });
		}
	}
	const exampleKeys = best.shared.slice(0, MAX_EXAMPLE_ROWS);
	const leftColumnIds = [best.leftColumn.id, ...companions.map((column) => column.id)].slice(0, 4);
	const rightColumnIds = [best.rightColumn.id, ...companions.map((column) => right.columns.find((other) => norm(other.name) === norm(column.name))!.id)].slice(0, 4);
	const disagreementText = disagreements.length
		? ` ${disagreements.length} of the shared keys have differing ${Array.from(new Set(disagreements.map((item) => item.column))).join(' / ')} values between the two files.`
		: companions.length ? ` Shared columns (${companions.map((column) => column.name).join(', ')}) agree for every shared key.` : '';
	return {
		kind: 'candidate_join',
		rank: 0,
		isLead: true,
		score: 60 + Math.min(30, best.shared.length) + (disagreements.length ? 15 : 0),
		title: `${left.name} and ${right.name} share ${best.shared.length} ${best.leftColumn.name} values`,
		claim: `${best.shared.length} distinct values of ${best.leftColumn.name} (${left.name}) also appear in ${best.rightColumn.name} (${right.name}), out of ${best.smaller} distinct values in the smaller column.${disagreementText}`,
		evidence: [
			{ documentId: left.documentId, documentName: left.name, sha256: left.sha256, kind: 'rows', columnIds: leftColumnIds, columnNames: columnNames(left, leftColumnIds), rows: rowRefs(left, exampleKeys.map((key) => leftByKey.get(key)!).filter(Boolean), leftColumnIds) },
			{ documentId: right.documentId, documentName: right.name, sha256: right.sha256, kind: 'rows', columnIds: rightColumnIds, columnNames: columnNames(right, rightColumnIds), rows: rowRefs(right, exampleKeys.map((key) => rightByKey.get(key)!).filter(Boolean), rightColumnIds) },
			...disagreements.slice(0, 3).flatMap((item) => [
				{ documentId: left.documentId, documentName: left.name, sha256: left.sha256, kind: 'rows' as const, columnIds: leftColumnIds, columnNames: columnNames(left, leftColumnIds), rows: rowRefs(left, [item.leftRow], leftColumnIds), excerpt: `Differs on ${item.column} for key "${item.key}"` },
				{ documentId: right.documentId, documentName: right.name, sha256: right.sha256, kind: 'rows' as const, columnIds: rightColumnIds, columnNames: columnNames(right, rightColumnIds), rows: rowRefs(right, [item.rightRow], rightColumnIds), excerpt: `Differs on ${item.column} for key "${item.key}"` }
			])
		],
		calculation: {
			method: 'Set intersection of trimmed, case-insensitive values; a join is proposed when at least 3 values and 10% of the smaller column match. Companion columns are compared on the first row per key.',
			parameters: { leftColumn: best.leftColumn.name, rightColumn: best.rightColumn.name, companionColumns: companions.map((column) => column.name) },
			counts: { sharedValues: best.shared.length, leftDistinct: new Set(left.rows.map((row) => norm(row.cells[leftIndex] ?? '')).filter(Boolean)).size, rightDistinct: new Set(right.rows.map((row) => norm(row.cells[rightIndex] ?? '')).filter(Boolean)).size, disagreements: disagreements.length }
		},
		limitations: 'Matching strings are not proof the records describe the same entity; names and codes collide. Only the first row per key was compared for companion columns.',
		nextQuestion: 'Is this the right key to join on, and what explains the keys whose details differ?',
		fingerprint: fingerprint(['candidate_join', [left.sha256, right.sha256].sort(), best.leftColumn.id, best.rightColumn.id])
	};
}

function amountOutliers(dataset: AnalysisDataset): Array<ProposedFinding & { score: number }> {
	const findings: Array<ProposedFinding & { score: number }> = [];
	for (const column of dataset.columns) {
		if (!(column.inferredType === 'decimal' || column.inferredType === 'integer') || !AMOUNT_COLUMN_RE.test(headerWords(column.name))) continue;
		const index = columnIndex(dataset, column.id);
		const values: Array<{ row: DatasetRow; units: bigint; scale: number }> = [];
		let unparsed = 0;
		for (const row of dataset.rows) {
			const raw = row.cells[index] ?? '';
			if (!raw.trim()) continue;
			const parsed = parseDecimal(raw);
			if (parsed) values.push({ row, ...parsed });
			else unparsed += 1;
		}
		if (values.length < 8) continue;
		const scale = Math.max(...values.map((value) => value.scale));
		const scaled = values.map((value) => ({ row: value.row, units: value.units * 10n ** BigInt(scale - value.scale) }));
		const sorted = [...scaled].sort((a, b) => (a.units < b.units ? -1 : a.units > b.units ? 1 : 0));
		const median = sorted[Math.floor(sorted.length / 2)].units;
		const deviations = sorted.map((value) => (value.units > median ? value.units - median : median - value.units)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const mad = deviations[Math.floor(deviations.length / 2)];
		if (mad === 0n) continue;
		const outliers = scaled.filter((value) => (value.units > median ? value.units - median : median - value.units) > mad * 5n).sort((a, b) => (b.units > a.units ? 1 : -1));
		if (outliers.length === 0) continue;
		const sum = scaled.reduce((total, value) => total + value.units, 0n);
		const companion = dataset.columns.filter((other) => other.id !== column.id && (isIdentifierColumn(other, dataset.rows.length) || COMPANION_RE.test(headerWords(other.name)))).slice(0, 2).map((other) => other.id);
		const columnIds = [...companion, column.id];
		findings.push({
			kind: 'amount_outliers',
			rank: 0,
			isLead: true,
			score: 10 + Math.min(20, outliers.length),
			title: `${outliers.length} unusual ${column.name} value${outliers.length === 1 ? '' : 's'} in ${dataset.name}`,
			claim: `${outliers.length} of ${values.length} ${column.name} values sit more than 5 median absolute deviations from the median of ${formatDecimal(median, scale)}. Largest: ${outliers.slice(0, 3).map((value) => `${formatDecimal(value.units, scale)} (row ${value.row.ordinal})`).join(', ')}. Column total: ${formatDecimal(sum, scale)}.`,
			evidence: [{ documentId: dataset.documentId, documentName: dataset.name, sha256: dataset.sha256, kind: 'rows', columnIds, columnNames: columnNames(dataset, columnIds), rows: rowRefs(dataset, outliers.map((value) => value.row), columnIds) }],
			calculation: {
				method: 'Exact decimal arithmetic on the cell text (currency symbols and thousands separators stripped). Outlier rule: |value - median| > 5 x median absolute deviation.',
				parameters: { column: column.name, median: formatDecimal(median, scale), mad: formatDecimal(mad, scale), threshold: '5 MAD' },
				counts: { rows: dataset.rows.length, numeric: values.length, unparsed, outliers: outliers.length }
			},
			limitations: `Values are compared as written; currencies and units are not normalized. ${unparsed} non-empty cells could not be parsed as numbers and were excluded.`,
			nextQuestion: 'Are these amounts explained by the row they sit in (one-off capital items, annual totals), or do they need a records request?',
			fingerprint: fingerprint(['amount_outliers', dataset.sha256, column.id])
		});
	}
	return findings;
}

function identifierMentions(dataset: AnalysisDataset, document: AnalysisDocument): (ProposedFinding & { score: number }) | null {
	let best: { column: DatasetColumn; hits: Array<{ value: string; row: DatasetRow; pageNumber: number }> } | null = null;
	for (const column of dataset.columns) {
		if (!isIdentifierColumn(column, dataset.rows.length)) continue;
		const index = columnIndex(dataset, column.id);
		const seen = new Set<string>();
		const hits: Array<{ value: string; row: DatasetRow; pageNumber: number }> = [];
		let scanned = 0;
		for (const row of dataset.rows) {
			if (scanned >= MAX_IDENTIFIER_SCAN) break;
			const value = (row.cells[index] ?? '').trim();
			const key = value.toLowerCase();
			if (value.length < 4 || !/[a-z0-9]/i.test(value) || seen.has(key)) continue;
			seen.add(key);
			scanned += 1;
			const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'iu');
			for (const page of document.pages) {
				if (pattern.test(page.text)) {
					hits.push({ value, row, pageNumber: page.pageNumber });
					break;
				}
			}
		}
		if (hits.length >= 2 && (!best || hits.length > best.hits.length)) best = { column, hits };
	}
	if (!best) return null;
	const column = best.column;
	const columnIds = [column.id];
	const pageEvidence: FindingEvidence[] = best.hits.slice(0, 5).map((hit) => {
		const page = document.pages.find((item) => item.pageNumber === hit.pageNumber)!;
		return { documentId: document.documentId, documentName: document.name, sha256: document.sha256, kind: 'page', pageNumber: hit.pageNumber, excerpt: excerptAround(page.text, hit.value) };
	});
	return {
		kind: 'identifier_mentions',
		rank: 0,
		isLead: true,
		score: 40 + Math.min(30, best.hits.length),
		title: `${best.hits.length} ${column.name} values from ${dataset.name} appear in ${document.name}`,
		claim: `${best.hits.length} distinct ${column.name} values in ${dataset.name} occur verbatim in ${document.name} (pages ${Array.from(new Set(best.hits.map((hit) => hit.pageNumber))).sort((a, b) => a - b).join(', ')}). Examples: ${best.hits.slice(0, 3).map((hit) => `"${hit.value}" (row ${hit.row.ordinal}, page ${hit.pageNumber})`).join(', ')}.`,
		evidence: [
			{ documentId: dataset.documentId, documentName: dataset.name, sha256: dataset.sha256, kind: 'rows', columnIds, columnNames: columnNames(dataset, columnIds), rows: rowRefs(dataset, best.hits.map((hit) => hit.row), columnIds) },
			...pageEvidence
		],
		calculation: {
			method: 'Whole-token, case-insensitive match of each distinct identifier (4+ characters) against extracted page text.',
			parameters: { column: column.name, scannedValues: Math.min(MAX_IDENTIFIER_SCAN, column.distinctCount) },
			counts: { matchedValues: best.hits.length, distinctValues: column.distinctCount, pages: document.pages.length }
		},
		limitations: 'A matching string shows the identifier is mentioned, not what the document says about it. Short or common codes can match unrelated text.',
		nextQuestion: 'What does the document say about each matched identifier, and does it agree with the spreadsheet row?',
		fingerprint: fingerprint(['identifier_mentions', dataset.sha256, document.sha256, column.id])
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function excerptAround(text: string, needle: string): string {
	const index = text.toLowerCase().indexOf(needle.toLowerCase());
	if (index < 0) return text.slice(0, 200).replace(/\s+/g, ' ').trim();
	const start = Math.max(0, index - 120);
	const end = Math.min(text.length, index + needle.length + 120);
	return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
