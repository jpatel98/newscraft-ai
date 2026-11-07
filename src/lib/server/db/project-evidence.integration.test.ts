import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, ensureMigrated } from './index';
import { createProject, deleteProject } from './projects';
import { createPostgresEvidenceRepository } from '$lib/server/evidence/repository';
import type { ProjectDocumentRow, ProjectFindingRow } from '$lib/server/evidence/types';

const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

function document(overrides: Partial<ProjectDocumentRow> & Pick<ProjectDocumentRow, 'id' | 'accountId' | 'projectId'>): ProjectDocumentRow {
 return {
  orgId: null, kind: 'csv', displayName: `${overrides.id}.csv`, mimeType: 'text/csv', declaredSizeBytes: 10, declaredSha256: 'a'.repeat(64),
  storageBucket: 'newsroom-artifacts', storagePath: `evidence/${overrides.accountId}/${overrides.projectId}/${overrides.id}`, state: 'uploading',
  sealedSha256: null, sealedSizeBytes: null, sealedAt: null, extractionVersion: 0, pageCount: null, rowCount: null, columnCount: null,
  failureCode: null, failureMessage: null, processingStartedAt: null, processedAt: null, createdAt: 1, updatedAt: 1, ...overrides
 };
}

function finding(overrides: Partial<ProjectFindingRow> & Pick<ProjectFindingRow, 'id' | 'accountId' | 'projectId' | 'fingerprint'>): ProjectFindingRow {
 return {
  runId: null, kind: 'duplicate_identifiers', rank: 1, title: 'Repeated ids', claim: 'CANARY-CLAIM', evidence: [], calculation: { method: 'm', parameters: {}, counts: {} },
  limitations: '', nextQuestion: '', status: 'proposed', reviewNote: '', dismissalReason: '', reviewedBy: null, reviewedAt: null, createdAt: 1, updatedAt: 1, ...overrides
 };
}

describe.skipIf(!url)('project evidence isolation (database)', () => {
 const repo = createPostgresEvidenceRepository();
 const a = `evidence-a-${Date.now()}`, b = `evidence-b-${Date.now()}`;
 let projectA: { id: string }, projectA2: { id: string }, projectB: { id: string };
 beforeAll(async () => {
  await ensureMigrated();
  for (const id of [a, b]) await sql`INSERT INTO accounts (id,email,name,role,created_at,updated_at) VALUES (${id},${id+'@example.test'},'Evidence test','member',1,1)`;
  projectA = await createProject(a, 'Project A'); projectA2 = await createProject(a, 'Project A2'); projectB = await createProject(b, 'Project B');
 });
 afterAll(async () => { await sql`DELETE FROM accounts WHERE id IN (${a},${b})`; await sql.end({ timeout: 1 }); });

 it('seals CSV evidence inside its project and keeps rows, pages and search bound to account and project', async () => {
  const doc = document({ id: 'doc-a1', accountId: a, projectId: projectA.id });
  await repo.createDocument(doc);
  const claimed = await repo.claimForProcessing(a, projectA.id, doc.id, 5);
  expect(claimed?.state).toBe('processing');
  const ready = await repo.sealCsv(claimed!, { sha256: 'b'.repeat(64), sizeBytes: 10, now: 6,
   dataset: { delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'csv-v1', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 2, distinctCount: 2 }], rowCount: 2, rejectedRows: 0 },
   rows: [{ ordinal: 1, sourceLine: 2, cells: ['CANARY-A-ROW'] }, { ordinal: 2, sourceLine: 3, cells: ['V-2'] }] });
  expect(ready).toMatchObject({ state: 'ready', sealedSha256: 'b'.repeat(64), rowCount: 2, columnCount: 1, extractionVersion: 1 });
  expect(await repo.listRows(a, projectA.id, doc.id, 0, 10)).toHaveLength(2);
  expect(await repo.searchRows(a, projectA.id, doc.id, ['canary'], 10)).toEqual([{ ordinal: 1, sourceLine: 2, cells: ['CANARY-A-ROW'] }]);
  // Same account, other project: nothing. Other account, right project id: nothing.
  expect(await repo.getDocument(a, projectA2.id, doc.id)).toBeUndefined();
  expect(await repo.getDocument(b, projectA.id, doc.id)).toBeUndefined();
  expect(await repo.listDocuments(b, projectA.id)).toEqual([]);
  expect(await repo.listRows(b, projectA.id, doc.id, 0, 10)).toEqual([]);
  expect(await repo.searchRows(a, projectA2.id, doc.id, ['canary'], 10)).toEqual([]);
  expect(await repo.getDataset(b, projectA.id, doc.id)).toBeUndefined();
  expect(await repo.claimForProcessing(b, projectA.id, doc.id, 7)).toBeUndefined();
  await repo.deleteDocument(b, projectA.id, doc.id);
  expect(await repo.getDocument(a, projectA.id, doc.id)).toMatchObject({ state: 'ready' });
 });

 it('a sealed document cannot be claimed for reprocessing', async () => {
  expect(await repo.claimForProcessing(a, projectA.id, 'doc-a1', 8)).toBeUndefined();
 });

 it('PDF pages are searchable only inside the owning project', async () => {
  const doc = document({ id: 'doc-a-pdf', accountId: a, projectId: projectA.id, kind: 'pdf', displayName: 'report.pdf', mimeType: 'application/pdf' });
  await repo.createDocument(doc);
  const claimed = await repo.claimForProcessing(a, projectA.id, doc.id, 5);
  await repo.sealPdf(claimed!, { sha256: 'c'.repeat(64), sizeBytes: 10, pages: ['Intro.', 'The CANARY-PAGE term appears here.'], now: 6 });
  expect((await repo.searchPages(a, projectA.id, [doc.id], 'canary-page', 5)).map((page) => page.pageNumber)).toEqual([2]);
  expect(await repo.searchPages(b, projectA.id, [doc.id], 'canary-page', 5)).toEqual([]);
  expect(await repo.searchPages(a, projectA2.id, [doc.id], 'canary-page', 5)).toEqual([]);
  expect(await repo.getPage(b, projectA.id, doc.id, 2)).toBeUndefined();
  expect((await repo.getPage(a, projectA.id, doc.id, 2))?.pageText).toContain('CANARY-PAGE');
 });

 it('the database refuses to attach evidence rows to another project or account', async () => {
  await expect(sql`INSERT INTO project_documents (id, account_id, project_id, kind, display_name, mime_type, declared_size_bytes, declared_sha256, storage_bucket, storage_path, created_at, updated_at)
   VALUES ('forged', ${b}, ${projectA.id}, 'csv', 'x.csv', 'text/csv', 1, ${'a'.repeat(64)}, 'bucket', 'path', 1, 1)`).rejects.toThrow();
  await expect(sql`INSERT INTO project_document_pages (id, document_id, account_id, project_id, page_number, page_text, char_count, created_at)
   VALUES ('forged:1', 'doc-a-pdf', ${a}, ${projectA2.id}, 1, 'x', 1, 1)`).rejects.toThrow();
  await expect(sql`UPDATE project_documents SET project_id = ${projectA2.id} WHERE id = 'doc-a1'`).rejects.toThrow();
  await expect(sql`INSERT INTO project_findings (id, account_id, project_id, kind, title, claim, evidence, calculation, fingerprint, created_at, updated_at)
   VALUES ('forged-f', ${b}, ${projectA.id}, 'k', 't', 'c', '[]', '{}', 'fp', 1, 1)`).rejects.toThrow();
 });

 it('findings are scoped, human review survives reruns, and deleting a source withdraws its excerpts', async () => {
  const saved = await repo.upsertFindings(a, projectA.id, [finding({ id: 'f-1', accountId: a, projectId: projectA.id, fingerprint: 'fp-1',
   evidence: [{ documentId: 'doc-a1', documentName: 'doc-a1.csv', sha256: 'b'.repeat(64), kind: 'rows', rows: [{ ordinal: 1, cells: { c1: 'CANARY-A-ROW' } }] }] })]);
  expect(saved).toHaveLength(1);
  expect(await repo.listFindings(b, projectA.id)).toEqual([]);
  expect(await repo.listFindings(a, projectA2.id)).toEqual([]);
  expect(await repo.getFinding(b, projectA.id, 'f-1')).toBeUndefined();
  expect(await repo.updateFindingStatus(b, projectA.id, 'f-1', { status: 'dismissed', dismissalReason: 'x', reviewedBy: b, now: 9 })).toBeUndefined();
  await expect(repo.upsertFindings(a, projectA.id, [finding({ id: 'f-x', accountId: b, projectId: projectA.id, fingerprint: 'fp-x' })])).rejects.toThrow('EVIDENCE_SCOPE_MISMATCH');
  const reviewed = await repo.updateFindingStatus(a, projectA.id, 'f-1', { status: 'reviewed', reviewNote: 'Checked rows', reviewedBy: a, now: 9 });
  expect(reviewed).toMatchObject({ status: 'reviewed', reviewNote: 'Checked rows', reviewedBy: a, reviewedAt: 9 });
  const evidence = saved[0].evidence;
  const rerun = await repo.upsertFindings(a, projectA.id, [finding({ id: 'f-2', accountId: a, projectId: projectA.id, fingerprint: 'fp-1', claim: 'refreshed', evidence })]);
  expect(rerun[0]).toMatchObject({ id: 'f-1', status: 'reviewed', claim: 'refreshed' });
  await repo.withdrawDocumentFromFindings(a, projectA.id, 'doc-a1', 10);
  const withdrawn = await repo.getFinding(a, projectA.id, 'f-1');
  expect(withdrawn?.status).toBe('stale');
  expect(withdrawn?.evidence[0]).toMatchObject({ documentId: 'doc-a1', withdrawn: true });
  expect(JSON.stringify(withdrawn?.evidence)).not.toContain('CANARY-A-ROW');
 });

 it('project B evidence stays invisible to project A listings even under the same table scan', async () => {
  await repo.createDocument(document({ id: 'doc-b1', accountId: b, projectId: projectB.id, displayName: 'CANARY-B.csv' }));
  const names = (await repo.listDocuments(a, projectA.id)).map((doc) => doc.displayName);
  expect(names).not.toContain('CANARY-B.csv');
  expect(names).toEqual(expect.arrayContaining(['doc-a1.csv', 'report.pdf']));
  expect(await repo.projectUsage(a, projectA.id)).toEqual({ count: 2, bytes: 20 });
 });

 it('deleting a project cascades its evidence rows', async () => {
  const temp = await createProject(a, 'Temp');
  await repo.createDocument(document({ id: 'doc-temp', accountId: a, projectId: temp.id }));
  expect(await deleteProject(a, temp.id)).toBe(true);
  expect(await sql`SELECT id FROM project_documents WHERE id = 'doc-temp'`).toEqual([]);
 });
});
