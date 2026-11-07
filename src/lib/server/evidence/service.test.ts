import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PdfExtractor } from '$lib/server/documents/types';
import { ProjectEvidenceService } from './service';
import type { EvidenceRepository, EvidenceStorage, ProjectDocumentRow, ProjectFindingRow } from './types';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);

function row(overrides: Partial<ProjectDocumentRow> = {}): ProjectDocumentRow {
	return {
		id: 'doc-1', accountId: 'acct-a', projectId: 'proj-a', orgId: null, kind: 'csv', displayName: 'vendors.csv', mimeType: 'text/csv',
		declaredSizeBytes: 10, declaredSha256: 'a'.repeat(64), storageBucket: 'newsroom-artifacts', storagePath: 'evidence/acct-a/proj-a/doc-1',
		state: 'uploading', sealedSha256: null, sealedSizeBytes: null, sealedAt: null, extractionVersion: 0, pageCount: null, rowCount: null,
		columnCount: null, failureCode: null, failureMessage: null, processingStartedAt: null, processedAt: null, createdAt: 1, updatedAt: 1, ...overrides
	};
}

function deps() {
	const repository = {
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
	it('issues an opaque, project-bound storage key and never echoes the declared hash', async () => {
		const { repository, storage, service } = deps();
		vi.mocked(storage.createSignedUpload).mockImplementation(async (_kind, path) => ({ path, token: 't', signedUrl: 'https://storage.example/v1/upload/t', contentType: 'text/csv' }));
		const result = await service.createUploadIntents({ id: 'proj-a', accountId: 'acct-a', orgId: null }, [
			{ filename: 'Secret Source List.csv', mimeType: 'text/csv', sizeBytes: 10, checksumSha256: 'a'.repeat(64), kind: 'csv', storedMimeType: 'text/csv' }
		]);
		expect(repository.createDocument).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-a', projectId: 'proj-a', storagePath: 'evidence/acct-a/proj-a/doc-1', state: 'uploading' }));
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
		expect(repository.markFailed).toHaveBeenCalledWith('acct-a', 'proj-a', 'doc-1', expect.objectContaining({ code: 'file_mismatch' }));
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
		vi.mocked(repository.getDocument).mockResolvedValue(row({ state: 'ready' }));
		await service.deleteDocument('acct-a', 'proj-a', 'doc-1');
		expect(storage.remove).toHaveBeenCalledWith('csv', 'evidence/acct-a/proj-a/doc-1');
		expect(repository.withdrawDocumentFromFindings).toHaveBeenCalledWith('acct-a', 'proj-a', 'doc-1', 100);
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
		vi.mocked(repository.latestRun).mockResolvedValue({ id: 'run-0', accountId: 'acct-a', projectId: 'proj-a', status: 'running', trigger: 'manual', analyzerVersion: 'x', inputDocuments: [], findingCount: 0, errorCode: null, errorMessage: null, startedAt: 90, finishedAt: null });
		await expect(service.runAnalysis('acct-a', 'proj-a', 'manual')).rejects.toMatchObject({ code: 'analysis_running' });
		vi.mocked(repository.latestRun).mockResolvedValue(undefined);
		vi.mocked(repository.listDocuments).mockResolvedValue([row({ id: 'csv-1', kind: 'csv', state: 'ready', sealedSha256: 'd'.repeat(64), extractionVersion: 1 })]);
		vi.mocked(repository.getDataset).mockResolvedValue({ documentId: 'csv-1', delimiter: ',', hasHeader: true, encoding: 'utf-8', parserVersion: 'csv-v1', columns: [{ id: 'c1', name: 'vendor_id', inferredType: 'text', nonEmptyCount: 2, distinctCount: 1 }], rowCount: 2, rejectedRows: 0 });
		vi.mocked(repository.listRows).mockResolvedValue([{ ordinal: 1, sourceLine: 2, cells: ['V-1'] }, { ordinal: 2, sourceLine: 3, cells: ['V-1'] }]);
		vi.mocked(repository.upsertFindings).mockImplementation(async (_account, _project, findings) => findings as ProjectFindingRow[]);
		const result = await service.runAnalysis('acct-a', 'proj-a', 'manual');
		expect(repository.createRun).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-a', projectId: 'proj-a', inputDocuments: [{ id: 'csv-1', sha256: 'd'.repeat(64), extractionVersion: 1 }] }));
		expect(result.findings.every((finding) => finding.accountId === 'acct-a' && finding.projectId === 'proj-a' && finding.runId === 'doc-1')).toBe(true);
		expect(result.findings.map((finding) => finding.kind)).toEqual(['duplicate_identifiers', 'dataset_summary']);
		expect(repository.finishRun).toHaveBeenCalledWith('acct-a', 'proj-a', 'doc-1', expect.objectContaining({ status: 'succeeded', findingCount: 2 }));
	});
});
