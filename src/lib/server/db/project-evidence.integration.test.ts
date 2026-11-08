import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, ensureMigrated } from './index';
import { createProject, deleteProject } from './projects';
import { createPostgresEvidenceRepository } from '$lib/server/evidence/repository';
import { ProjectEvidenceService } from '$lib/server/evidence/service';
import { createHash, randomUUID } from 'node:crypto';
import { ANALYSIS_RUN_STALE_MS, PROCESSING_CLAIM_STALE_MS, MAX_ANALYSIS_SOURCE_BYTES, MAX_PROJECT_SOURCE_BYTES, MAX_ANALYSIS_CELLS, MAX_ANALYSIS_PAGES } from '$lib/server/evidence/constants';
import type { AnalysisRunRow, EvidenceStorage, ProjectDocumentRow, ProjectFindingRow } from '$lib/server/evidence/types';

const url = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';

function document(overrides: Partial<ProjectDocumentRow> & Pick<ProjectDocumentRow, 'id' | 'accountId' | 'projectId'>): ProjectDocumentRow {
 return {
  orgId: null, kind: 'csv', displayName: `${overrides.id}.csv`, mimeType: 'text/csv', declaredSizeBytes: 10, declaredSha256: 'a'.repeat(64),
  storageBucket: 'newsroom-artifacts', storagePath: `evidence/${overrides.accountId}/${overrides.projectId}/${overrides.id}`, state: 'uploading',
  sealedSha256: null, sealedSizeBytes: null, sealedAt: null, extractionVersion: 0, pageCount: null, rowCount: null, columnCount: null,
  failureCode: null, failureMessage: null, processingStartedAt: null, processingToken: null, extractedChars: 0, processedAt: null, createdAt: 1, updatedAt: 1, ...overrides
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
  await expect(repo.claimForProcessing(b, projectA.id, doc.id, 7)).rejects.toMatchObject({ status: 404 });
  await expect(repo.deleteDocument(b, projectA.id, doc.id)).rejects.toMatchObject({ status: 404 });
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
  expect(rerun[0]).toMatchObject({ id: 'f-1', status: 'reviewed', claim: 'CANARY-CLAIM', reviewNote: 'Checked rows', reviewedBy: a, reviewedAt: 9 });
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

 function run(projectId: string, startedAt = Date.now()): AnalysisRunRow {
  return { id: randomUUID(), accountId: a, projectId, status: 'running', trigger: 'manual', analyzerVersion: 'test', inputDocuments: [], findingCount: 0, errorCode: null, errorMessage: null, startedAt, finishedAt: null };
 }

 async function readyCsv(projectId: string) {
  const source = document({ id: randomUUID(), accountId: a, projectId });
  await repo.createDocument(source);
  const claim = await repo.claimForProcessing(a, projectId, source.id, Date.now());
  return repo.sealCsv(claim!, { sha256: source.declaredSha256, sizeBytes: source.declaredSizeBytes, now: Date.now(),
   dataset: { delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'csv-v1', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 2, distinctCount: 1 }], rowCount: 2, rejectedRows: 0 },
   rows: [{ ordinal: 1, sourceLine: 2, cells: ['V-1'] }, { ordinal: 2, sourceLine: 3, cells: ['V-1'] }] });
 }

 it('fences reclaimed processing attempts and stale failures before touching extracted rows', async () => {
  const project = await createProject(a, 'Claim fencing');
  const source = document({ id: randomUUID(), accountId: a, projectId: project.id, kind: 'pdf' });
  await repo.createDocument(source);
  const first = await repo.claimForProcessing(a, project.id, source.id, 100);
  expect(await repo.claimForProcessing(a, project.id, source.id, 99 + PROCESSING_CLAIM_STALE_MS)).toBeUndefined();
  const replacement = await repo.claimForProcessing(a, project.id, source.id, 100 + PROCESSING_CLAIM_STALE_MS);
  expect(replacement?.processingToken).not.toBe(first?.processingToken);
  await repo.markFailed(first!, { code: 'old', message: 'Old worker', now: 200 + PROCESSING_CLAIM_STALE_MS });
  expect((await repo.getDocument(a, project.id, source.id))?.processingToken).toBe(replacement?.processingToken);
  await expect(repo.sealPdf(first!, { sha256: source.declaredSha256, sizeBytes: 10, pages: ['Old result'], now: 201 + PROCESSING_CLAIM_STALE_MS })).rejects.toMatchObject({ code: 'processing_claim_lost' });
  await repo.sealPdf(replacement!, { sha256: source.declaredSha256, sizeBytes: 10, pages: ['Current result'], now: 202 + PROCESSING_CLAIM_STALE_MS });
  await repo.markFailed(first!, { code: 'old', message: 'Old worker', now: 203 + PROCESSING_CLAIM_STALE_MS });
  expect((await repo.getPage(a, project.id, source.id, 1))?.pageText).toBe('Current result');
  expect((await repo.getDocument(a, project.id, source.id))?.state).toBe('ready');
 });

 it('serializes count and byte reservations at the project limit', async () => {
  const countProject = await createProject(a, 'Count reservation');
  await repo.reserveDocuments(a, countProject.id, Array.from({ length: 99 }, () => document({ id: randomUUID(), accountId: a, projectId: countProject.id })));
  const countResults = await Promise.allSettled([1, 2].map(() => repo.createDocument(document({ id: randomUUID(), accountId: a, projectId: countProject.id }))));
  expect(countResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await repo.projectUsage(a, countProject.id)).count).toBe(100);
  const byteProject = await createProject(a, 'Byte reservation');
  await repo.createDocument(document({ id: randomUUID(), accountId: a, projectId: byteProject.id, declaredSizeBytes: MAX_PROJECT_SOURCE_BYTES - 10 }));
  const byteResults = await Promise.allSettled([1, 2].map(() => repo.createDocument(document({ id: randomUUID(), accountId: a, projectId: byteProject.id }))));
  expect(byteResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await repo.projectUsage(a, byteProject.id)).bytes).toBe(MAX_PROJECT_SOURCE_BYTES);
 });

 it('allows only one initial processing claim and one replacement at the five-minute lease boundary', async () => {
  const project = await createProject(a, 'Concurrent processing claims');
  const source = document({ id: randomUUID(), accountId: a, projectId: project.id });
  await repo.createDocument(source);
  const firstClaims = await Promise.all([1, 2].map(() => repo.claimForProcessing(a, project.id, source.id, 100)));
  const first = firstClaims.find((claim) => claim);
  expect(firstClaims.filter(Boolean)).toHaveLength(1);
  const replacements = await Promise.all([1, 2].map(() => repo.claimForProcessing(a, project.id, source.id, 100 + PROCESSING_CLAIM_STALE_MS)));
  const replacement = replacements.find((claim) => claim);
  expect(replacements.filter(Boolean)).toHaveLength(1);
  expect(replacement?.processingToken).not.toBe(first?.processingToken);
  await repo.markFailed(first!, { code: 'stale_failure', message: 'Synthetic stale failure', now: 101 + PROCESSING_CLAIM_STALE_MS });
  expect((await repo.getDocument(a, project.id, source.id))?.processingToken).toBe(replacement?.processingToken);
 });

 it('serializes concurrent file deletions and fences a paused extractor from publishing afterwards', async () => {
  const project = await createProject(a, 'Delete versus extractor');
  const bytes = new TextEncoder().encode('%PDF-1.7 synthetic fixture');
  const extracting = deferred(), finishExtraction = deferred(), removing = deferred(), finishRemoval = deferred();
  let removalCount = 0;
  const storage: EvidenceStorage = {
   bucketFor: () => 'fixture', verifyCapability: async () => {},
   createSignedUpload: async (_kind, path, _max, contentType) => ({ path, contentType, token: 'synthetic', signedUrl: 'https://unused.invalid/upload' }),
   download: async () => bytes, createSignedDownload: async () => 'https://unused.invalid/download',
   remove: async () => { if (++removalCount === 2) removing.release(); await finishRemoval.promise; }
  };
  const service = new ProjectEvidenceService(repo, storage, {
   extract: async () => { extracting.release(); await finishExtraction.promise; return { pageCount: 1, pages: ['WITHDRAWN-EXTRACTOR-CANARY'] }; }
  }, Date.now, randomUUID);
  const [intent] = await service.createUploadIntents({ id: project.id, accountId: a, orgId: null }, [{ filename: 'source.pdf', mimeType: 'application/pdf', kind: 'pdf', storedMimeType: 'application/pdf', sizeBytes: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex') }]);
  const documentId = intent.document.id;
  const processing = service.finalizeDocument(a, project.id, documentId).then(() => ({ code: 'unexpected_success' }), (error) => error);
  await extracting.promise;
  const deletions = Promise.all([1, 2].map(() => service.deleteDocument(a, project.id, documentId)));
  try {
   await removing.promise;
   expect(await repo.getDocument(a, project.id, documentId)).toMatchObject({ state: 'deleting', processingToken: null });
   finishRemoval.release();
   await deletions;
  } finally { finishRemoval.release(); finishExtraction.release(); }
  expect(await processing).toMatchObject({ code: 'processing_claim_lost' });
  expect(await repo.getDocument(a, project.id, documentId)).toBeUndefined();
  expect(await repo.listPages(a, project.id, [documentId])).toEqual([]);
  expect(await service.buildChatContext({ accountId: a, projectId: project.id, query: 'CANARY' })).toEqual([]);
 });

 it('serializes project deletion with reservations and retains nonempty projects', async () => {
  const project = await createProject(a, 'Delete versus reserve');
  const results = await Promise.allSettled([
   repo.deleteProject(a, project.id),
   repo.createDocument(document({ id: randomUUID(), accountId: a, projectId: project.id }))
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const [surviving] = await sql`SELECT id FROM projects WHERE id = ${project.id} AND account_id = ${a}`;
  if (surviving) {
   await expect(repo.deleteProject(a, project.id)).rejects.toMatchObject({ code: 'project_has_evidence' });
   expect((await repo.projectUsage(a, project.id)).count).toBe(1);
  } else expect(await repo.listDocuments(a, project.id)).toEqual([]);
  await expect(repo.deleteProject(b, projectA.id)).rejects.toMatchObject({ status: 404 });
 });

 it('admits one analysis, cancels stale runs, and rejects late publication', async () => {
  const project = await createProject(a, 'Analysis fencing');
  await readyCsv(project.id);
  const attempts = [run(project.id, 100), run(project.id, 100)];
  const results = await Promise.allSettled(attempts.map((attempt) => repo.startRun(attempt)));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const active = attempts[results.findIndex((result) => result.status === 'fulfilled')];
  const replacement = run(project.id, 100 + ANALYSIS_RUN_STALE_MS);
  await repo.startRun(replacement);
  await expect(repo.publishRun(active, [], replacement.startedAt + 1)).rejects.toMatchObject({ code: 'evidence_changed' });
  await repo.finishRun(a, project.id, active.id, { status: 'failed', findingCount: 0, now: replacement.startedAt + 2 });
  const [old] = await sql`SELECT status FROM project_analysis_runs WHERE id = ${active.id}`;
  expect(old.status).toBe('cancelled');
  expect((await repo.latestRun(a, project.id))?.id).toBe(replacement.id);
 });

 it.each(['bytes', 'cells', 'pages'] as const)('rejects aggregate %s metadata over budget before analysis', async (budget) => {
  const project = await createProject(a, `Analysis ${budget} budget`);
  const source = await readyCsv(project.id);
  if (budget === 'bytes') await sql`UPDATE project_documents SET declared_size_bytes = ${MAX_ANALYSIS_SOURCE_BYTES + 1} WHERE id = ${source.id}`;
  if (budget === 'cells') await sql`UPDATE project_documents SET row_count = ${MAX_ANALYSIS_CELLS + 1}, column_count = 1 WHERE id = ${source.id}`;
  if (budget === 'pages') await sql`UPDATE project_documents SET page_count = ${MAX_ANALYSIS_PAGES + 1} WHERE id = ${source.id}`;
  await expect(repo.startRun(run(project.id))).rejects.toMatchObject({ code: 'analysis_limit_exceeded', status: 413 });
  expect(await repo.latestRun(a, project.id)).toBeUndefined();
 });

 it('does not cancel a newer analysis when retrying deletion of a source absent from its snapshot', async () => {
  const project = await createProject(a, 'Deletion retry snapshot');
  const withdrawn = await readyCsv(project.id);
  const retained = await readyCsv(project.id);
  const now = Date.now();
  const originalRun = run(project.id, now);
  expect((await repo.startRun(originalRun)).map((source) => source.id).sort()).toEqual([withdrawn.id, retained.id].sort());
  await repo.beginDelete(a, project.id, withdrawn.id, now + 1);
  expect((await repo.latestRun(a, project.id))?.status).toBe('cancelled');
  const currentRun = run(project.id, now + 2);
  expect((await repo.startRun(currentRun)).map((source) => source.id)).toEqual([retained.id]);
  await repo.beginDelete(a, project.id, withdrawn.id, now + 3);
  expect(await repo.latestRun(a, project.id)).toMatchObject({ id: currentRun.id, status: 'running' });
  const proposal = finding({ id: randomUUID(), accountId: a, projectId: project.id, runId: currentRun.id, fingerprint: randomUUID(),
   evidence: [{ documentId: retained.id, documentName: retained.displayName, sha256: retained.sealedSha256!, kind: 'rows', rows: [{ ordinal: 1, cells: { c1: 'V-1' } }] }] });
  expect(await repo.publishRun(currentRun, [proposal], now + 4)).toHaveLength(1);
  expect(await repo.latestRun(a, project.id)).toMatchObject({ id: currentRun.id, status: 'succeeded' });
  await expect(repo.publishRun(originalRun, [], now + 5)).rejects.toMatchObject({ code: 'evidence_changed' });
 });

 it.each([false, true])('never republishes a deleted CSV from cached service results (existing finding: %s)', async (warmup) => {
  const project = await createProject(a, 'Late publish');
  const repository = createPostgresEvidenceRepository();
  const bytes = new TextEncoder().encode('vendor_id,amount\nV-1,10\nV-1,20\n');
  let failCleanup = false;
  const storage: EvidenceStorage = {
   bucketFor: () => 'fixture', verifyCapability: async () => {},
   createSignedUpload: async (_kind, path, _max, contentType) => ({ path, contentType, token: 'synthetic', signedUrl: 'https://unused.invalid/upload' }),
   download: async () => bytes, createSignedDownload: async () => 'https://unused.invalid/download',
   remove: async () => { if (failCleanup) throw new Error('Synthetic cleanup failure'); }
  };
  const service = new ProjectEvidenceService(repository, storage, { extract: async () => { throw new Error('Unexpected PDF'); } }, Date.now, randomUUID);
  const [intent] = await service.createUploadIntents({ id: project.id, accountId: a, orgId: null }, [{ filename: 'sample.csv', mimeType: 'text/csv', kind: 'csv', storedMimeType: 'text/csv', sizeBytes: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex') }]);
  const documentId = intent.document.id;
  await service.finalizeDocument(a, project.id, documentId);
  let reviewedId: string | undefined;
  if (warmup) {
   const initial = await service.runAnalysis(a, project.id, 'manual');
   reviewedId = initial.findings[0].id;
   await service.reviewFinding(a, project.id, reviewedId, { status: 'reviewed', reviewNote: 'Verified source', dismissalReason: '' });
  }
  const entered = deferred(), release = deferred();
  const publish = repository.publishRun.bind(repository);
  repository.publishRun = async (...args) => { entered.release(); await release.promise; return publish(...args); };
  const pending = service.runAnalysis(a, project.id, 'manual').then(() => ({ code: 'unexpected_success' }), (error) => error);
  await entered.promise;
  try {
   failCleanup = true;
   await expect(service.deleteDocument(a, project.id, documentId)).rejects.toThrow('Synthetic cleanup failure');
   expect((await repository.getDocument(a, project.id, documentId))?.state).toBe('deleting');
   expect(await repository.listRows(a, project.id, documentId, 0, 10)).toEqual([]);
   await expect(service.deleteProject(a, project.id)).rejects.toMatchObject({ code: 'project_has_evidence' });
   failCleanup = false;
   await service.deleteDocument(a, project.id, documentId);
  } finally { release.release(); }
  expect(await pending).toMatchObject({ code: 'evidence_changed' });
  expect(await repository.getDocument(a, project.id, documentId)).toBeUndefined();
  const findings = await repository.listFindings(a, project.id);
  expect(JSON.stringify(findings.map((item) => item.evidence))).not.toContain('V-1');
  if (reviewedId) {
   expect(await repository.getFinding(a, project.id, reviewedId)).toMatchObject({ status: 'stale', reviewedBy: a, reviewNote: 'Verified source' });
   await expect(service.reviewFinding(a, project.id, reviewedId, { status: 'proposed', reviewNote: '', dismissalReason: '' })).rejects.toMatchObject({ code: 'source_withdrawn' });
  } else expect(findings).toEqual([]);
 });

 it('enforces composite run ownership and RLS on every evidence table', async () => {
  const project = await createProject(a, 'Run owner');
  await readyCsv(project.id);
  const attempt = run(project.id);
  await repo.startRun(attempt);
  await expect(repo.upsertFindings(b, projectB.id, [finding({ id: randomUUID(), accountId: b, projectId: projectB.id, runId: attempt.id, fingerprint: randomUUID() })])).rejects.toThrow();
  const rows = await sql`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('project_documents', 'project_document_pages', 'project_datasets', 'project_dataset_rows', 'project_analysis_runs', 'project_findings') AND relnamespace = 'public'::regnamespace`;
  expect(rows).toHaveLength(6);
  expect(rows.every((row) => row.relrowsecurity)).toBe(true);
 });
});

function deferred() {
 let release!: () => void;
 const promise = new Promise<void>((resolve) => { release = resolve; });
 return { promise, release };
}
