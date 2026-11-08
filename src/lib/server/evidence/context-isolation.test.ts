import { describe, expect, it, vi } from 'vitest';
import type { PdfExtractor } from '$lib/server/documents/types';
import { ProjectEvidenceService } from './service';
import type { DatasetRow, EvidenceRepository, EvidenceStorage, ProjectDatasetRow, ProjectDocumentRow, ProjectDocumentPageRow } from './types';

/**
 * An in-memory repository that holds evidence for two accounts and two
 * projects and answers only for the exact (account, project) it is asked
 * about, as the Postgres repository does. The canary strings prove that
 * context assembly never widens a scope.
 */
function fixture(csvRows: DatasetRow[] = [{ ordinal: 1, sourceLine: 2, cells: ['V-1'] }]) {
 const docs: ProjectDocumentRow[] = [
  doc('a-pdf', 'acct-a', 'proj-a', 'pdf', 'a-report.pdf'),
  doc('a-csv', 'acct-a', 'proj-a', 'csv', 'a-vendors.csv'),
  doc('a2-csv', 'acct-a', 'proj-a2', 'csv', 'CANARY-SAME-ACCOUNT-OTHER-PROJECT.csv'),
  doc('b-pdf', 'acct-b', 'proj-b', 'pdf', 'CANARY-OTHER-ACCOUNT.pdf')
 ];
 const pages: Record<string, ProjectDocumentPageRow[]> = {
  'a-pdf': [{ documentId: 'a-pdf', pageNumber: 1, pageText: 'Vendor V-1 received a contract.', charCount: 31 }],
  'b-pdf': [{ documentId: 'b-pdf', pageNumber: 1, pageText: 'CANARY-OTHER-ACCOUNT-TEXT vendor V-1.', charCount: 38 }]
 };
 const datasets: Record<string, ProjectDatasetRow> = {
  'a-csv': { documentId: 'a-csv', delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'v', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 1, distinctCount: 1 }], rowCount: 1, rejectedRows: 0 },
  'a2-csv': { documentId: 'a2-csv', delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'v', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 1, distinctCount: 1 }], rowCount: 1, rejectedRows: 0 }
 };
 const rows: Record<string, DatasetRow[]> = {
  'a-csv': csvRows,
  'a2-csv': [{ ordinal: 1, sourceLine: 2, cells: ['CANARY-SAME-ACCOUNT-OTHER-PROJECT-ROW'] }]
 };
 const owned = (accountId: string, projectId: string, documentId: string) => docs.some((d) => d.id === documentId && d.accountId === accountId && d.projectId === projectId);
 const repository = {
  listDocuments: vi.fn(async (accountId: string, projectId: string) => docs.filter((d) => d.accountId === accountId && d.projectId === projectId)),
  searchPages: vi.fn(async (accountId: string, projectId: string, ids: string[]) => ids.filter((id) => owned(accountId, projectId, id)).flatMap((id) => (pages[id] ?? []).map((page) => ({ ...page, rank: 1 })))),
  listPagesPrefix: vi.fn(async (accountId: string, projectId: string, ids: string[]) => ids.filter((id) => owned(accountId, projectId, id)).flatMap((id) => pages[id] ?? [])),
  getDataset: vi.fn(async (accountId: string, projectId: string, id: string) => (owned(accountId, projectId, id) ? datasets[id] : undefined)),
  searchRows: vi.fn(async (accountId: string, projectId: string, id: string) => (owned(accountId, projectId, id) ? rows[id] ?? [] : [])),
  listRows: vi.fn(async (accountId: string, projectId: string, id: string) => (owned(accountId, projectId, id) ? rows[id] ?? [] : []))
 } as unknown as EvidenceRepository;
 const storage = { bucketFor: () => 'b' } as unknown as EvidenceStorage;
 const extractor = { extract: vi.fn() } as unknown as PdfExtractor;
 return new ProjectEvidenceService(repository, storage, extractor, () => 1, () => 'id');
}

function doc(id: string, accountId: string, projectId: string, kind: 'pdf' | 'csv', displayName: string): ProjectDocumentRow {
 return {
  id, accountId, projectId, orgId: null, kind, displayName, mimeType: kind === 'pdf' ? 'application/pdf' : 'text/csv', declaredSizeBytes: 1, declaredSha256: 'a'.repeat(64),
  storageBucket: 'b', storagePath: `evidence/${accountId}/${projectId}/${id}`, state: 'ready', sealedSha256: id.padEnd(64, '0'), sealedSizeBytes: 1, sealedAt: 1,
  extractionVersion: 1, pageCount: kind === 'pdf' ? 1 : null, rowCount: kind === 'csv' ? 1 : null, columnCount: kind === 'csv' ? 1 : null,
  failureCode: null, failureMessage: null, processingStartedAt: null, processingToken: null, extractedChars: 0, processedAt: 1, createdAt: 1, updatedAt: 1
 };
}

describe('project evidence chat context isolation', () => {
 it('a project A chat receives only project A evidence, even when the query matches canaries elsewhere', async () => {
  const service = fixture();
  const context = await service.buildChatContext({ accountId: 'acct-a', projectId: 'proj-a', query: 'vendor V-1 CANARY' });
  const serialized = JSON.stringify(context);
  expect(context.map((document) => document.id).sort()).toEqual(['a-csv', 'a-pdf']);
  expect(serialized).not.toContain('CANARY');
  expect(serialized).toContain('Vendor V-1 received a contract.');
  expect(context.find((document) => document.id === 'a-csv')?.pages[0].text).toContain('row 1: vendor_id="V-1"');
  expect(context.find((document) => document.id === 'a-csv')?.pages[0].label).toBe('rows 1');
  expect(context.every((document) => document.downloadUrl?.startsWith('/api/projects/proj-a/evidence/'))).toBe(true);
 });

 it('a forged project id or another account yields no evidence at all', async () => {
  const service = fixture();
  expect(await service.buildChatContext({ accountId: 'acct-a', projectId: 'proj-b', query: 'vendor' })).toEqual([]);
  expect(await service.buildChatContext({ accountId: 'acct-b', projectId: 'proj-a', query: 'vendor' })).toEqual([]);
  expect(await service.buildChatContext({ accountId: 'acct-c', projectId: 'proj-a', query: 'vendor' })).toEqual([]);
 });

 it('caps the characters handed to the model', async () => {
  const service = fixture();
  const context = await service.buildChatContext({ accountId: 'acct-a', projectId: 'proj-a', query: 'vendor', charLimit: 20 });
  const total = context.reduce((sum, document) => sum + document.pages.reduce((inner, page) => inner + page.text.length, 0), 0);
  expect(total).toBeLessThanOrEqual(20);
 });

 it('labels actual selected CSV ordinals and discloses partial context without citing unseen rows', async () => {
  const service = fixture([{ ordinal: 4, sourceLine: 5, cells: ['V-4'] }, { ordinal: 19, sourceLine: 20, cells: ['V-19'] }]);
  const input = { accountId: 'acct-a', projectId: 'proj-a', query: 'vendor' };
  const full = await service.buildChatContext(input);
  const csv = full.find((document) => document.id === 'a-csv')!;
  expect(csv.pages[0].label).toBe('rows 4, 19');
  const pdfLength = full.find((document) => document.id === 'a-pdf')!.pages[0].text.length;
  const charLimit = pdfLength + csv.pages[0].text.indexOf('row 4:') + 8;
  const partial = await service.buildChatContext({ ...input, charLimit });
  const excerpt = partial.find((document) => document.id === 'a-csv')!.pages[0];
  expect(excerpt.label).toBe('rows 4 (partial excerpt)');
  expect(excerpt.text).toContain('row 4:');
  expect(excerpt.text).not.toContain('row 19:');
 });
});

