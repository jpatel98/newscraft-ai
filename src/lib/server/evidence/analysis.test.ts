import { describe, expect, it } from 'vitest';
import { analyzeEvidence, type AnalysisDataset, type AnalysisDocument } from './analysis';
import { parseCsv } from './csv';

const encode = (text: string) => new TextEncoder().encode(text);

function dataset(documentId: string, name: string, csv: string): AnalysisDataset {
	const parsed = parseCsv(encode(csv));
	return { documentId, name, sha256: documentId.repeat(8).slice(0, 64), columns: parsed.columns, rows: parsed.rows, rejectedRows: parsed.raggedRows };
}

const contracts = dataset('a1', 'contracts.csv', [
	'vendor_id,vendor_name,address,amount',
	'V-1001,Acme Paving,10 King St,12000',
	'V-1002,Beta Signs,22 Queen St,800',
	'V-1003,Gamma Lights,5 Bay St,950',
	'V-1004,Delta Roads,9 Front St,1100',
	'V-1001,Acme Paving,10 King St,13000',
	'V-1005,Epsilon Fence,1 Lake Rd,700',
	'V-1006,Zeta Glass,3 Hill Ave,650',
	'V-1007,Eta Steel,8 Park Ln,900',
	'V-1008,Theta Pipe,4 Elm St,1200',
	'V-1009,Iota Tile,7 Oak St,1000',
	'V-1010,Kappa Wire,6 Pine St,990000',
	'V-1002,Beta Signs,22 Queen St,820'
].join('\n'));

const vendors = dataset('b2', 'vendors.csv', [
	'vendor_id,address,contact',
	'V-1001,10 King St,a@example.test',
	'V-1002,99 Other St,b@example.test',
	'V-1003,5 Bay St,c@example.test',
	'V-2000,Nowhere,d@example.test',
	'V-1004,9 Front St,e@example.test',
	'V-2001,Elsewhere,f@example.test',
	'V-2002,Anywhere,g@example.test',
	'V-2003,Somewhere,h@example.test',
	'V-2004,Overthere,i@example.test',
	'V-2005,Underthere,j@example.test'
].join('\n'));

const report: AnalysisDocument = {
	documentId: 'c3',
	name: 'audit.pdf',
	sha256: 'c'.repeat(64),
	pages: [
		{ pageNumber: 1, text: 'Introduction. No vendors are named on this page.' },
		{ pageNumber: 4, text: 'The auditor reviewed V-1001 and V-1003 and found paperwork for V-1010 incomplete.' }
	]
};

describe('deterministic evidence analysis', () => {
	const findings = analyzeEvidence({ datasets: [contracts, vendors], documents: [report] });
	const byKind = (kind: string) => findings.find((finding) => finding.kind === kind);

	it('limits leads to three ranked cards and always includes dataset summaries', () => {
		const leads = findings.filter((finding) => finding.isLead);
		expect(leads).toHaveLength(3);
		expect(leads.map((finding) => finding.rank)).toEqual([1, 2, 3]);
		const summaries = findings.filter((finding) => finding.kind === 'dataset_summary');
		expect(summaries).toHaveLength(2);
		expect(summaries[0].rank).toBe(0);
	});

	it('finds the shared vendor ids between two files with exact counts and the differing address', () => {
		const join = byKind('candidate_join');
		expect(join).toBeDefined();
		expect(join!.rank).toBe(1);
		expect(join!.calculation.counts).toMatchObject({ sharedValues: 4, leftDistinct: 10, rightDistinct: 10, disagreements: 1 });
		expect(join!.claim).toContain('4 distinct values of vendor_id');
		expect(join!.claim).toContain('1 of the shared keys have differing address');
		const rows = join!.evidence.flatMap((item) => item.rows ?? []);
		expect(rows.some((row) => row.cells.c1 === 'V-1002')).toBe(true);
		expect(join!.evidence[0].columnNames).toEqual(['vendor_id', 'address']);
	});

	it('reports identifiers that appear verbatim in a PDF with page citations', () => {
		const mentions = byKind('identifier_mentions');
		expect(mentions).toBeDefined();
		expect(mentions!.calculation.counts.matchedValues).toBe(3);
		expect(mentions!.evidence.filter((item) => item.kind === 'page').map((item) => item.pageNumber)).toEqual([4, 4, 4]);
		expect(mentions!.evidence[0].rows?.map((row) => row.ordinal)).toEqual([1, 3, 11]);
	});

	it('counts repeated identifiers exactly and never calls them wrongdoing', () => {
		const duplicates = analyzeEvidence({ datasets: [contracts], documents: [] }).find((finding) => finding.kind === 'duplicate_identifiers');
		expect(duplicates).toBeDefined();
		expect(duplicates!.calculation.counts).toMatchObject({ rows: 12, repeatedValues: 2, rowsInRepeats: 4 });
		expect(duplicates!.claim).toMatch(/"V-1001" \(2 rows\)/);
		expect(duplicates!.claim.toLowerCase()).not.toMatch(/fraud|misconduct/);
		expect(duplicates!.evidence[0].rows?.map((row) => row.ordinal)).toEqual([1, 5]);
	});

	it('flags amount outliers with exact decimal totals', () => {
		const outliers = analyzeEvidence({ datasets: [contracts], documents: [] }).find((finding) => finding.kind === 'amount_outliers');
		expect(outliers).toBeDefined();
		expect(outliers!.calculation.counts.outliers).toBe(3);
		expect(outliers!.claim).toContain('990000 (row 11)');
		expect(outliers!.claim).toContain('Column total: 1023120');
	});

	it('is deterministic: the same inputs produce the same fingerprints in the same order', () => {
		const again = analyzeEvidence({ datasets: [vendors, contracts], documents: [report] });
		expect(again.map((finding) => finding.fingerprint)).toEqual(findings.map((finding) => finding.fingerprint));
	});

	it('does not propose a join when too few values overlap', () => {
		const unrelated = dataset('z9', 'unrelated.csv', 'vendor_id,amount\nX-1,5\nX-2,6\nX-3,7\nX-4,8\nX-5,9\nX-6,10\nX-7,11\nX-8,12\nX-9,13\nX-10,14');
		const result = analyzeEvidence({ datasets: [contracts, unrelated], documents: [] });
		expect(result.find((finding) => finding.kind === 'candidate_join')).toBeUndefined();
	});
});
