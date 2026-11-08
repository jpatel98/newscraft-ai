import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PdfExtractor } from '$lib/server/documents/types';
import { ProjectEvidenceService } from './service';
import { DocumentError } from '$lib/server/documents/errors';
import { createSupabaseEvidenceStorage, createVpsEvidenceStorage } from './storage';
import { readJsonObject } from './http';
import type { EvidenceRepository, EvidenceStorage, ProjectDocumentRow, ProjectFindingRow } from './types';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);

function row(overrides: Partial<ProjectDocumentRow> = {}): ProjectDocumentRow {
	return {
		id: 'doc-1', accountId: 'acct-a', projectId: 'proj-a', orgId: null, kind: 'csv', displayName: 'vendors.csv', mimeType: 'text/csv',
		declaredSizeBytes: 10, declaredSha256: 'a'.repeat(64), storageBucket: 'newsroom-artifacts', storagePath: 'evidence/acct-a/proj-a/doc-1',
		state: 'uploading', sealedSha256: null, sealedSizeBytes: null, sealedAt: null, extractionVersion: 0, pageCount: null, rowCount: null,
		columnCount: null, failureCode: null, failureMessage: null, processingStartedAt: null, processingToken: null, extractedChars: 0, processedAt: null, createdAt: 1, updatedAt: 1, ...overrides
	};
}

function deps() {
	const repository = {
		reserveDocuments: vi.fn(), beginDelete: vi.fn(), deleteProject: vi.fn(), startRun: vi.fn(), publishRun: vi.fn(),
		createDocument: vi.fn(), getDocument: vi.fn(), listDocuments: vi.fn().mockResolvedValue([]), projectUsage: vi.fn().mockResolvedValue({ count: 0, bytes: 0 }),
		claimForProcessing: vi.fn(), markFailed: vi.fn(), sealPdf: vi.fn(), sealCsv: vi.fn(), deleteDocument: vi.fn(), getPage: vi.fn(), listPages: vi.fn().mockResolvedValue([]),
		searchPages: vi.fn().mockResolvedValue([]), listPagesPrefix: vi.fn().mockResolvedValue([]), getDataset: vi.fn(), listRows: vi.fn().mockResolvedValue([]),
		listRowsByOrdinals: vi.fn().mockResolvedValue([]), searchRows: vi.fn().mockResolvedValue([]), createRun: vi.fn(), finishRun: vi.fn(), latestRun: vi.fn(),
		listFindings: vi.fn().mockResolvedValue([]), getFinding: vi.fn(), upsertFindings: vi.fn(), updateFindingStatus: vi.fn(), withdrawDocumentFromFindings: vi.fn()
	} as unknown as EvidenceRepository;
	const storage = {
		createSignedUpload: vi.fn(), download: vi.fn(), createSignedDownload: vi.fn(), remove: vi.fn(), bucketFor: vi.fn((kind: string) => kind === 'pdf' ? 'newsroom-documents' : 'newsroom-artifacts'), verifyCapability: vi.fn()
	} as unknown as EvidenceStorage;
	const extractor = { extract: vi.fn(), verifyCapability: vi.fn() } as unknown as PdfExtractor;
	const service = new ProjectEvidenceService(repository, storage, extractor, () => 100, () => 'doc-1');
	return { repository, storage, extractor, service };
}

describe('project evidence service', () => {
	it.each(['pdf', 'csv'] as const)('fails closed for unsupported Supabase %s capability, intents and deletion', async (kind) => {
		const { repository, extractor } = deps();
		const storage = createSupabaseEvidenceStorage();
		const service = new ProjectEvidenceService(repository, storage, extractor);
		const failure = { status: 503, code: 'evidence_gateway_required', message: expect.stringContaining('Supabase project evidence is not supported') };
		await expect(storage.verifyCapability()).rejects.toMatchObject(failure);
		await expect(service.verifyCapability()).rejects.toMatchObject(failure);
		const mimeType = kind === 'pdf' ? 'application/pdf' : 'text/csv';
		await expect(storage.createSignedUpload(kind, 'evidence/account/project/document', 10, mimeType)).rejects.toMatchObject(failure);
		await expect(storage.remove(kind, 'evidence/account/project/document')).rejects.toMatchObject(failure);
		await expect(service.createUploadIntents({ accountId: 'acct-a', id: 'proj-a', orgId: null }, [{ filename: `sample.${kind}`, mimeType, storedMimeType: mimeType, kind, sizeBytes: 10, checksumSha256: 'a'.repeat(64) }])).rejects.toMatchObject(failure);
		expect(repository.reserveDocuments).not.toHaveBeenCalled();
		vi.mocked(repository.beginDelete).mockResolvedValue(row({ kind, state: 'deleting' }));
		await expect(service.deleteDocument('acct-a', 'proj-a', 'doc-1')).rejects.toMatchObject(failure);
		expect(repository.deleteDocument).not.toHaveBeenCalled();
	});

	it('requires acknowledged revocation and retains the persisted bucket during cleanup', async () => {
		const { repository, extractor } = deps();
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'X-NewsCraft-Upload-Revoked': '1' } }));
		const storage = createVpsEvidenceStorage({ baseUrl: 'https://storage.example.test', apiKey: 'synthetic', fetchImpl, csvBucket: 'new-bucket' });
		const service = new ProjectEvidenceService(repository, storage, extractor);
		vi.mocked(repository.beginDelete).mockResolvedValue(row({ state: 'deleting', storageBucket: 'original-bucket' }));
		await expect(service.deleteDocument('acct-a', 'proj-a', 'doc-1')).rejects.toMatchObject({ code: 'evidence_storage_unavailable' });
		expect(repository.deleteDocument).not.toHaveBeenCalled();
		await service.deleteDocument('acct-a', 'proj-a', 'doc-1');
		expect(repository.deleteDocument).toHaveBeenCalledTimes(1);
		const target = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(target.searchParams.get('bucket')).toBe('original-bucket');
		expect(target.searchParams.get('revokeUploads')).toBe('true');
	});

	it('bounds metadata bodies without trusting a missing or false content length', async () => {
		await expect(readJsonObject(new Request('https://unused.invalid', { method: 'POST', body: '{"documents":[]}' }))).resolves.toEqual({ documents: [] });
		await expect(readJsonObject(new Request('https://unused.invalid', { method: 'POST', headers: { 'content-length': '1' }, body: JSON.stringify({ name: 'x'.repeat(16 * 1024) }) }))).rejects.toMatchObject({ status: 413 });
		await expect(readJsonObject(new Request('https://unused.invalid', { method: 'POST', headers: { 'content-length': '16385' }, body: '{}' }))).rejects.toMatchObject({ status: 413 });
	});

	it('issues an opaque, project-bound storage key and never echoes the declared hash', async () => {
		const { repository, storage, service } = deps();
		vi.mocked(storage.createSignedUpload).mockImplementation(async (_kind, path) => ({ path, token: 't', signedUrl: 'https://storage.example/v1/upload/t', contentType: 'text/csv' }));
		const result = await service.createUploadIntents({ id: 'proj-a', accountId: 'acct-a', orgId: null }, [
			{ filename: 'Secret Source List.csv', mimeType: 'text/csv', sizeBytes: 10, checksumSha256: 'a'.repeat(64), kind: 'csv', storedMimeType: 'text/csv' }
		]);
		expect(repository.reserveDocuments).toHaveBeenCalledWith('acct-a', 'proj-a', [expect.objectContaining({ accountId: 'acct-a', projectId: 'proj-a', storagePath: 'evidence/acct-a/proj-a/doc-1', state: 'uploading' })]);
		expect(repository.projectUsage).not.toHaveBeenCalled();
		expect(result[0].upload.path).not.toContain('Secret');
		expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
		expect(result[0].document).toMatchObject({ name: 'Secret Source List.csv', kind: 'csv', state: 'uploading' });
	});

	it('refuses to seal bytes whose size or hash differ from the declaration', async () => {
		const { repository, storage, service } = deps();
		const bytes = encode('id,amount\n1,2\n');
		vi.mocked(repository.getDocument).mockResolvedValue(row({ declaredSizeBytes: bytes.byteLength, declaredSha256: 'f'.repeat(64) }));
		vi.mocked(repository.claimForProcessing).mockResolvedValue(row({ state: 'processing', declaredSizeBytes: bytes.byteLength, declaredSha256: 'f'.repeat(64) }));
		vi.mocked(storage.download).mockResolvedValue(bytes);
		await expect(service.finalizeDocument('acct-a', 'proj-a', 'doc-1')).rejects.toMatchObject({ code: 'file_mismatch', status: 422 });
		expect(repository.markFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1', state: 'processing' }), expect.objectContaining({ code: 'file_mismatch' }));
		expect(repository.sealCsv).not.toHaveBeenCalled();
	});

	it('seals a matching CSV with the server-computed hash and parsed rows', async () => {
		const { repository, storage, service } = deps();
		const bytes = encode('vendor_id,amount\nV-1,10\nV-2,20\n');
		const declared = row({ declaredSizeBytes: bytes.byteLength, declaredSha256: sha(bytes) });
		vi.mocked(repository.getDocument).mockResolvedValue(declared);
		vi.mocked(repository.claimForProcessing).mockResolvedValue({ ...declared, state: 'processing' });
		vi.mocked(storage.download).mockResolvedValue(bytes);
		vi.mocked(repository.sealCsv).mockImplementation(async (document, seal) => ({ ...document, state: 'ready', sealedSha256: seal.sha256, rowCount: seal.rows.length, columnCount: seal.dataset.columns.length }));
		const ready = await service.finalizeDocument('acct-a', 'proj-a', 'doc-1');
		expect(ready).toMatchObject({ state: 'ready', sha256: sha(bytes), rowCount: 2, columnCount: 2 });
		expect(vi.mocked(repository.sealCsv).mock.calls[0][1].rows[1]).toEqual({ ordinal: 2, sourceLine: 3, cells: ['V-2', '20'] });
	});

	it('does not reprocess a sealed document, so a second upload cannot replace evidence', async () => {
		const { repository, storage, service } = deps();
		vi.mocked(repository.getDocument).mockResolvedValue(row({ state: 'ready', sealedSha256: 'b'.repeat(64) }));
		const result = await service.finalizeDocument('acct-a', 'proj-a', 'doc-1');
		expect(result.state).toBe('ready');
		expect(storage.download).not.toHaveBeenCalled();
		expect(repository.claimForProcessing).not.toHaveBeenCalled();
	});

	it('rejects a PDF-shaped or binary upload declared as CSV', async () => {
		const { repository, storage, service } = deps();
		const bytes = encode('%PDF-1.7 not a csv');
		const declared = row({ declaredSizeBytes: bytes.byteLength, declaredSha256: sha(bytes) });
		vi.mocked(repository.getDocument).mockResolvedValue(declared);
		vi.mocked(repository.claimForProcessing).mockResolvedValue({ ...declared, state: 'processing' });
		vi.mocked(storage.download).mockResolvedValue(bytes);
		await expect(service.finalizeDocument('acct-a', 'proj-a', 'doc-1')).rejects.toMatchObject({ code: 'csv_only' });
	});

	it('scopes every lookup to the account and project it was asked for', async () => {
		const { repository, service } = deps();
		vi.mocked(repository.getDocument).mockResolvedValue(undefined);
		await expect(service.getDocument('acct-b', 'proj-a', 'doc-1')).rejects.toMatchObject({ status: 404 });
		await expect(service.createDownloadUrl('acct-a', 'proj-other', 'doc-1')).rejects.toMatchObject({ status: 404 });
		await expect(service.deleteDocument('acct-a', 'proj-other', 'doc-1')).rejects.toMatchObject({ status: 404 });
		expect(repository.getDocument).toHaveBeenCalledWith('acct-b', 'proj-a', 'doc-1');
		expect(repository.getDocument).toHaveBeenCalledWith('acct-a', 'proj-other', 'doc-1');
	});

	it('withdraws a deleted source from findings before removing it', async () => {
		const { repository, storage, service } = deps();
		vi.mocked(repository.beginDelete).mockResolvedValue(row({ state: 'deleting' }));
		await service.deleteDocument('acct-a', 'proj-a', 'doc-1');
		expect(storage.remove).toHaveBeenCalledWith('csv', 'evidence/acct-a/proj-a/doc-1', 'newsroom-artifacts');
		expect(repository.beginDelete).toHaveBeenCalledWith('acct-a', 'proj-a', 'doc-1', 100);
		expect(repository.deleteDocument).toHaveBeenCalledWith('acct-a', 'proj-a', 'doc-1');
	});

	it('builds chat context only from ready documents of the requested project, bounded by characters', async () => {
		const { repository, service } = deps();
		vi.mocked(repository.listDocuments).mockResolvedValue([
			row({ id: 'pdf-1', kind: 'pdf', displayName: 'report.pdf', state: 'ready', pageCount: 3, sealedSha256: 'c'.repeat(64) }),
			row({ id: 'csv-1', kind: 'csv', displayName: 'vendors.csv', state: 'ready', rowCount: 2, sealedSha256: 'd'.repeat(64) }),
			row({ id: 'csv-2', kind: 'csv', displayName: 'pending.csv', state: 'processing' })
		]);
		vi.mocked(repository.searchPages).mockResolvedValue([{ documentId: 'pdf-1', pageNumber: 2, pageText: 'Vendor V-1 paid.', charCount: 16, rank: 0.5 }]);
		vi.mocked(repository.getDataset).mockResolvedValue({ documentId: 'csv-1', delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'csv-v1', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 2, distinctCount: 2 }], rowCount: 2, rejectedRows: 0 });
		vi.mocked(repository.searchRows).mockResolvedValue([{ ordinal: 1, sourceLine: 2, cells: ['V-1'] }]);
		const context = await service.buildChatContext({ accountId: 'acct-a', projectId: 'proj-a', query: 'what did vendor V-1 receive?' });
		expect(repository.listDocuments).toHaveBeenCalledWith('acct-a', 'proj-a');
		expect(repository.searchPages).toHaveBeenCalledWith('acct-a', 'proj-a', ['pdf-1'], 'what did vendor V-1 receive?', expect.any(Number));
		expect(context.map((document) => document.id)).toEqual(['pdf-1', 'csv-1']);
		expect(context[0]).toMatchObject({ downloadUrl: '/api/projects/proj-a/evidence/pdf-1/download', checksum: 'c'.repeat(64), pages: [{ pageNumber: 2, text: 'Vendor V-1 paid.' }] });
		expect(context[1].pages[0].text).toContain('row 1: vendor_id="V-1"');
		expect(vi.mocked(repository.getDataset)).not.toHaveBeenCalledWith('acct-a', 'proj-a', 'csv-2');
	});

	it('runs analysis once at a time and persists findings bound to the run', async () => {
		const { repository, service } = deps();
		vi.mocked(repository.startRun).mockRejectedValueOnce(new DocumentError(409, 'analysis_running', 'An analysis is already running.'));
		await expect(service.runAnalysis('acct-a', 'proj-a', 'manual')).rejects.toMatchObject({ code: 'analysis_running' });
		vi.mocked(repository.startRun).mockResolvedValue([row({ id: 'csv-1', kind: 'csv', state: 'ready', sealedSha256: 'd'.repeat(64), extractionVersion: 1 })]);
		vi.mocked(repository.getDataset).mockResolvedValue({ documentId: 'csv-1', delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'csv-v1', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 2, distinctCount: 1 }], rowCount: 2, rejectedRows: 0 });
		vi.mocked(repository.listRows).mockResolvedValue([{ ordinal: 1, sourceLine: 2, cells: ['V-1'] }, { ordinal: 2, sourceLine: 3, cells: ['V-1'] }]);
		vi.mocked(repository.publishRun).mockImplementation(async (_run, findings) => findings as ProjectFindingRow[]);
		const result = await service.runAnalysis('acct-a', 'proj-a', 'manual');
		expect(repository.startRun).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-a', projectId: 'proj-a', inputDocuments: [{ id: 'csv-1', sha256: 'd'.repeat(64), extractionVersion: 1 }] }));
		expect(result.findings.every((finding) => finding.accountId === 'acct-a' && finding.projectId === 'proj-a' && finding.runId === 'doc-1')).toBe(true);
		expect(result.findings.map((finding) => finding.kind)).toEqual(['duplicate_identifiers', 'dataset_summary']);
		expect(repository.publishRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1' }), expect.any(Array), 100);
		expect(repository.finishRun).not.toHaveBeenCalled();
	});

	it('retains a deletion tombstone when revoking storage fails, then retries cleanup', async () => {
		const { repository, storage, service } = deps();
		vi.mocked(repository.beginDelete).mockResolvedValue(row({ state: 'deleting' }));
		vi.mocked(storage.remove).mockRejectedValueOnce(new Error('synthetic storage failure')).mockResolvedValue(undefined);
		await expect(service.deleteDocument('acct-a', 'proj-a', 'doc-1')).rejects.toThrow('synthetic storage failure');
		expect(repository.deleteDocument).not.toHaveBeenCalled();
		await service.deleteDocument('acct-a', 'proj-a', 'doc-1');
		expect(repository.deleteDocument).toHaveBeenCalledTimes(1);
	});

	it('does not erase a failed upload reservation unless storage revocation succeeds', async () => {
		const { repository, storage, service } = deps();
		vi.mocked(storage.createSignedUpload).mockRejectedValue(new Error('synthetic grant failure'));
		vi.mocked(repository.beginDelete).mockResolvedValue(row({ state: 'deleting' }));
		vi.mocked(storage.remove).mockRejectedValue(new Error('synthetic revoke failure'));
		await expect(service.createUploadIntents({ id: 'proj-a', accountId: 'acct-a', orgId: null }, [{
			filename: 'sample.csv', mimeType: 'text/csv', kind: 'csv', storedMimeType: 'text/csv', sizeBytes: 10, checksumSha256: 'a'.repeat(64)
		}])).rejects.toThrow('synthetic grant failure');
		expect(repository.beginDelete).toHaveBeenCalled();
		expect(repository.deleteDocument).not.toHaveBeenCalled();
	});

	it('reclaims an abandoned processing attempt using the repository CAS token', async () => {
		const { repository, storage, service } = deps();
		const bytes = encode('vendor_id,amount\nV-1,10\n');
		const old = row({ state: 'processing', processingToken: 'old', declaredSha256: sha(bytes), declaredSizeBytes: bytes.length });
		const current = { ...old, processingToken: 'replacement' };
		vi.mocked(repository.getDocument).mockResolvedValue(old);
		vi.mocked(repository.claimForProcessing).mockResolvedValue(current);
		vi.mocked(storage.download).mockResolvedValue(bytes);
		vi.mocked(repository.sealCsv).mockResolvedValue({ ...current, state: 'ready' });
		await service.finalizeDocument('acct-a', 'proj-a', 'doc-1');
		expect(repository.sealCsv).toHaveBeenCalledWith(current, expect.any(Object));
	});

	it('does not load rows or pages after an aggregate budget rejection', async () => {
		const { repository, service } = deps();
		vi.mocked(repository.startRun).mockRejectedValue(new DocumentError(413, 'analysis_limit_exceeded', 'Evidence exceeds the analysis limit.'));
		await expect(service.runAnalysis('acct-a', 'proj-a', 'manual')).rejects.toMatchObject({ code: 'analysis_limit_exceeded' });
		expect(repository.listRows).not.toHaveBeenCalled();
		expect(repository.listPages).not.toHaveBeenCalled();
	});

	it('labels unmatched CSV fallback rows as a sample rather than matches', async () => {
		const { repository, service } = deps();
		vi.mocked(repository.listDocuments).mockResolvedValue([row({ state: 'ready' })]);
		vi.mocked(repository.getDataset).mockResolvedValue({ documentId: 'doc-1', delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'csv-v1', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 1, distinctCount: 1 }], rowCount: 1, rejectedRows: 0 });
		vi.mocked(repository.listRows).mockResolvedValue([{ ordinal: 1, sourceLine: 2, cells: ['V-1'] }]);
		const context = await service.buildChatContext({ accountId: 'acct-a', projectId: 'proj-a', query: 'zzznomatch' });
		expect(context[0].pages[0].text).toContain('sample, not query matches');
		expect(context[0].pages[0].text).not.toContain('those matching the question');
	});
});

