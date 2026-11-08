import { createHash } from 'node:crypto';
import type { DocumentContext } from '@newscraft/shared';
import { newId } from '$lib/utils/id';
import { DocumentError, documentErrorFromUnknown } from '$lib/server/documents/errors';
import { hasPdfSignature } from '$lib/server/documents/pdf';
import type { PdfExtractor } from '$lib/server/documents/types';
import { analyzeEvidence, type AnalysisDataset, type AnalysisDocument } from './analysis';
import {
	ANALYZER_VERSION,
	CSV_PARSER_VERSION,
	EVIDENCE_CONTEXT_CHAR_LIMIT,
	EVIDENCE_CONTEXT_PAGE_LIMIT,
	EVIDENCE_CONTEXT_ROW_LIMIT,
	EVIDENCE_ROW_BLOCK_SIZE,
	MAX_EXTRACTED_DOCUMENT_CHARS,
	MAX_EVIDENCE_PDF_BYTES,
	MAX_EVIDENCE_PDF_PAGES,
	SIGNED_DOWNLOAD_TTL_SECONDS
} from './constants';
import { parseCsv } from './csv';
import type {
	AnalysisRunRow,
	DatasetRow,
	EvidenceRepository,
	EvidenceStorage,
	FindingStatus,
	OwnedProject,
	ProjectDocumentRow,
	ProjectFindingRow,
	PublicEvidenceDocument,
	ValidatedEvidenceUpload
} from './types';

export class ProjectEvidenceService {
	constructor(
		private readonly repository: EvidenceRepository,
		private readonly storage: EvidenceStorage,
		private readonly extractor: PdfExtractor,
		private readonly now: () => number = Date.now,
		private readonly createId: () => string = newId
	) {}

	/**
	 * Step 1 of the upload protocol: reserve a row and a one-key upload grant.
	 * The storage key is opaque (ids only); the filename stays in the catalog.
	 * The browser's hash is recorded as a declaration and verified at sealing.
	 */
	async createUploadIntents(project: OwnedProject, uploads: ValidatedEvidenceUpload[]) {
		const created: ProjectDocumentRow[] = uploads.map((upload) => {
				const id = this.createId();
				const timestamp = this.now();
				const row: ProjectDocumentRow = {
					id,
					accountId: project.accountId,
					projectId: project.id,
					orgId: project.orgId,
					kind: upload.kind,
					displayName: upload.filename,
					mimeType: upload.storedMimeType,
					declaredSizeBytes: upload.sizeBytes,
					declaredSha256: upload.checksumSha256,
					storageBucket: this.storage.bucketFor(upload.kind),
					storagePath: `evidence/${project.accountId}/${project.id}/${id}`,
					state: 'uploading',
					sealedSha256: null,
					sealedSizeBytes: null,
					sealedAt: null,
					extractionVersion: 0,
					pageCount: null,
					rowCount: null,
					columnCount: null,
					failureCode: null,
					failureMessage: null,
					processingStartedAt: null,
					processingToken: null,
					extractedChars: 0,
					processedAt: null,
					createdAt: timestamp,
					updatedAt: timestamp
				};
				return row;
		});
		await this.repository.reserveDocuments(project.accountId, project.id, created);
		try {
			const results = [];
			for (const row of created) {
				const signed = await this.storage.createSignedUpload(row.kind, row.storagePath, row.declaredSizeBytes, row.mimeType);
				if (signed.path !== row.storagePath) {
					throw new DocumentError(503, 'evidence_storage_unavailable', 'Evidence storage is unavailable right now.');
				}
				results.push({ document: publicDocument(row), upload: { path: signed.path, token: signed.token, signedUrl: signed.signedUrl, contentType: signed.contentType } });
			}
			return results;
		} catch (error) {
			for (const row of created) {
				await this.deleteDocument(row.accountId, row.projectId, row.id).catch(() => undefined);
			}
			throw error;
		}
	}

	async listDocuments(accountId: string, projectId: string): Promise<PublicEvidenceDocument[]> {
		return (await this.repository.listDocuments(accountId, projectId)).map(publicDocument);
	}

	async getDocument(accountId: string, projectId: string, documentId: string): Promise<PublicEvidenceDocument> {
		return publicDocument(await this.requireDocument(accountId, projectId, documentId));
	}

	/**
	 * Step 2: seal and extract. The uploaded bytes must match the declared size
	 * and hash exactly; only then do they become a source revision. A document
	 * that is already ready is immutable: a second upload to the same id cannot
	 * replace what was sealed.
	 */
	async finalizeDocument(accountId: string, projectId: string, documentId: string): Promise<PublicEvidenceDocument> {
		const existing = await this.requireDocument(accountId, projectId, documentId);
		if (existing.state === 'ready') return publicDocument(existing);
		if (existing.state === 'deleting') throw new DocumentError(409, 'document_deleting', 'This file is being deleted. Retry deletion to finish cleanup.');
		const processing = await this.repository.claimForProcessing(accountId, projectId, documentId, this.now());
		if (!processing) throw new DocumentError(409, 'already_processing', 'This file is still being processed.');
		try {
			const bytes = await this.storage.download(processing.kind, processing.storagePath, processing.storageBucket);
			const sizeLimit = processing.kind === 'pdf' ? MAX_EVIDENCE_PDF_BYTES : processing.declaredSizeBytes;
			if (bytes.byteLength > Math.max(sizeLimit, processing.declaredSizeBytes)) {
				throw new DocumentError(413, 'evidence_too_large', 'The uploaded file is larger than allowed.');
			}
			const sha256 = hashBytes(bytes);
			if (bytes.byteLength !== processing.declaredSizeBytes || sha256 !== processing.declaredSha256) {
				throw new DocumentError(422, 'file_mismatch', 'The uploaded bytes did not match the selected file. Upload it again.');
			}
			if (processing.kind === 'pdf') {
				if (!hasPdfSignature(bytes)) throw new DocumentError(415, 'pdf_only', 'This file is not a PDF.');
				const extraction = await this.extractor.extract(bytes);
				if (extraction.pageCount < 1 || extraction.pageCount > MAX_EVIDENCE_PDF_PAGES || extraction.pageCount !== extraction.pages.length) {
					throw new DocumentError(422, 'unreadable_pdf', 'NewsCraft could not read this PDF.');
				}
				if (extraction.pages.reduce((sum, page) => sum + page.length, 0) > MAX_EXTRACTED_DOCUMENT_CHARS) {
					throw new DocumentError(413, 'extracted_text_limit', 'The extracted document text exceeds the evidence limit.');
				}
				const ready = await this.repository.sealPdf(processing, { sha256, sizeBytes: bytes.byteLength, pages: extraction.pages, now: this.now() });
				return publicDocument(ready);
			}
			if (hasPdfSignature(bytes) || looksBinary(bytes)) throw new DocumentError(415, 'csv_only', 'This file is not a CSV.');
			const parsed = parseCsv(bytes);
			const ready = await this.repository.sealCsv(processing, {
				sha256,
				sizeBytes: bytes.byteLength,
				dataset: {
					delimiter: parsed.delimiter,
					hasHeader: parsed.hasHeader,
					encoding: parsed.encoding,
					parserVersion: CSV_PARSER_VERSION,
					columns: parsed.columns,
					rowCount: parsed.rows.length,
					rejectedRows: parsed.raggedRows
				},
				rows: parsed.rows,
				now: this.now()
			});
			return publicDocument(ready);
		} catch (error) {
			const failure = documentErrorFromUnknown(error);
			await this.repository.markFailed(processing, { code: failure.code, message: failure.message, now: this.now() });
			throw failure;
		}
	}

	async createDownloadUrl(accountId: string, projectId: string, documentId: string): Promise<string> {
		const document = await this.requireDocument(accountId, projectId, documentId);
		if (document.state !== 'ready') throw new DocumentError(409, 'document_not_ready', 'This file is not ready yet.');
		return this.storage.createSignedDownload(document.kind, document.storagePath, SIGNED_DOWNLOAD_TTL_SECONDS, document.storageBucket);
	}

	/** Deleting evidence withdraws it from every finding that cited it. */
	async deleteDocument(accountId: string, projectId: string, documentId: string): Promise<void> {
		const document = await this.repository.beginDelete(accountId, projectId, documentId, this.now());
		if (!document) throw new DocumentError(404, 'document_not_found', 'File not found.');
		await this.storage.remove(document.kind, document.storagePath, document.storageBucket);
		await this.repository.deleteDocument(accountId, projectId, documentId);
	}

	async deleteProject(accountId: string, projectId: string): Promise<void> {
		await this.repository.deleteProject(accountId, projectId);
	}

	async getPage(accountId: string, projectId: string, documentId: string, pageNumber: number) {
		const document = await this.requireDocument(accountId, projectId, documentId);
		if (document.kind !== 'pdf' || document.state !== 'ready') throw new DocumentError(409, 'document_not_ready', 'This file has no pages to show.');
		const page = await this.repository.getPage(accountId, projectId, documentId, pageNumber);
		if (!page) throw new DocumentError(404, 'page_not_found', 'That page does not exist.');
		return { documentId, pageNumber: page.pageNumber, text: page.pageText, pageCount: document.pageCount ?? 0 };
	}

	async getRows(accountId: string, projectId: string, documentId: string, options: { offset?: number; limit?: number; ordinals?: number[] }) {
		const document = await this.requireDocument(accountId, projectId, documentId);
		if (document.kind !== 'csv' || document.state !== 'ready') throw new DocumentError(409, 'document_not_ready', 'This file has no rows to show.');
		const dataset = await this.repository.getDataset(accountId, projectId, documentId);
		if (!dataset) throw new DocumentError(409, 'document_not_ready', 'This file has no rows to show.');
		const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
		const rows = options.ordinals
			? await this.repository.listRowsByOrdinals(accountId, projectId, documentId, options.ordinals.slice(0, 200))
			: await this.repository.listRows(accountId, projectId, documentId, Math.max(0, Math.floor(options.offset ?? 0)), limit);
		return { documentId, columns: dataset.columns, rowCount: dataset.rowCount, hasHeader: dataset.hasHeader, delimiter: dataset.delimiter, rows };
	}

	/**
	 * Evidence context for a project chat. Only ready documents of this exact
	 * project are consulted; pages are ranked by the query, CSV rows by term
	 * matches, and the total is bounded so one turn cannot carry a corpus.
	 */
	async buildChatContext(input: { accountId: string; projectId: string; query: string; charLimit?: number }): Promise<DocumentContext[]> {
		const charLimit = input.charLimit ?? EVIDENCE_CONTEXT_CHAR_LIMIT;
		const documents = (await this.repository.listDocuments(input.accountId, input.projectId)).filter((document) => document.state === 'ready');
		if (documents.length === 0) return [];
		let remaining = charLimit;
		const output: DocumentContext[] = [];
		const downloadUrl = (documentId: string) => `/api/projects/${input.projectId}/evidence/${documentId}/download`;
		const pdfIds = documents.filter((document) => document.kind === 'pdf').map((document) => document.id);
		if (pdfIds.length) {
			const ranked = await this.repository.searchPages(input.accountId, input.projectId, pdfIds, input.query, EVIDENCE_CONTEXT_PAGE_LIMIT);
			const pages = ranked.length ? ranked : await this.repository.listPagesPrefix(input.accountId, input.projectId, pdfIds, EVIDENCE_CONTEXT_PAGE_LIMIT);
			const grouped = new Map<string, DocumentContext>();
			for (const page of pages) {
				if (remaining <= 0) break;
				const document = documents.find((item) => item.id === page.documentId);
				if (!document) continue;
				const text = page.pageText.slice(0, remaining);
				if (!text) continue;
				remaining -= text.length;
				const entry = grouped.get(document.id) ?? { id: document.id, filename: document.displayName, downloadUrl: downloadUrl(document.id), checksum: document.sealedSha256 ?? undefined, pageCount: document.pageCount ?? 0, pages: [] };
				entry.pages.push({ pageNumber: page.pageNumber, text });
				grouped.set(document.id, entry);
			}
			for (const entry of grouped.values()) {
				entry.pages.sort((a, b) => a.pageNumber - b.pageNumber);
				output.push(entry);
			}
		}
		const terms = queryTerms(input.query);
		for (const document of documents.filter((item) => item.kind === 'csv')) {
			if (remaining <= 0) break;
			const dataset = await this.repository.getDataset(input.accountId, input.projectId, document.id);
			if (!dataset) continue;
			let rows = terms.length ? await this.repository.searchRows(input.accountId, input.projectId, document.id, terms, EVIDENCE_CONTEXT_ROW_LIMIT) : [];
			const matched = rows.length > 0;
			if (rows.length === 0) rows = await this.repository.listRows(input.accountId, input.projectId, document.id, 0, EVIDENCE_ROW_BLOCK_SIZE);
			const header = `Columns: ${dataset.columns.map((column) => `${column.name} [${column.inferredType}]`).join(' | ')}. ${dataset.rowCount.toLocaleString('en-US')} rows total; the rows below are ${matched ? 'those matching the question' : 'the first rows (sample, not query matches)'}. Cite rows by number.`;
			const pages: DocumentContext['pages'] = [];
			for (let index = 0; index < rows.length; index += EVIDENCE_ROW_BLOCK_SIZE) {
				const blockRows = rows.slice(index, index + EVIDENCE_ROW_BLOCK_SIZE);
				const renderedRows = blockRows.map((row) => renderRow(row, dataset.columns));
				const prefix = index === 0 ? `${header}\n` : '';
				const completeText = prefix + renderedRows.join('\n');
				const text = completeText.slice(0, Math.max(0, remaining));
				const visibleOrdinals: number[] = [];
				let rowOffset = prefix.length;
				for (const [rowIndex, row] of blockRows.entries()) {
					if (rowOffset >= text.length) break;
					visibleOrdinals.push(row.ordinal);
					rowOffset += renderedRows[rowIndex].length + 1;
				}
				if (visibleOrdinals.length === 0) break;
				remaining -= text.length;
				const label = `rows ${visibleOrdinals.join(', ')}${text.length < completeText.length ? ' (partial excerpt)' : ''}`;
				pages.push({ pageNumber: pages.length + 1, label, text });
			}
			if (pages.length) {
				output.push({ id: document.id, filename: document.displayName, downloadUrl: downloadUrl(document.id), checksum: document.sealedSha256 ?? undefined, pageCount: pages.length, pages });
			}
		}
		return output;
	}

	/** Deterministic analysis over every ready document; at most one run at a time per project. */
	async runAnalysis(accountId: string, projectId: string, trigger: 'manual' | 'auto'): Promise<{ run: AnalysisRunRow; findings: ProjectFindingRow[] }> {
		const run: AnalysisRunRow = {
			id: this.createId(),
			accountId,
			projectId,
			status: 'running',
			trigger,
			analyzerVersion: ANALYZER_VERSION,
			inputDocuments: [],
			findingCount: 0,
			errorCode: null,
			errorMessage: null,
			startedAt: this.now(),
			finishedAt: null
		};
		const documents = await this.repository.startRun(run);
		run.inputDocuments = documents.map((document) => ({ id: document.id, sha256: document.sealedSha256 ?? '', extractionVersion: document.extractionVersion }));
		try {
			const datasets: AnalysisDataset[] = [];
			const pdfs: AnalysisDocument[] = [];
			for (const document of documents) {
				if (document.kind === 'csv') {
					const dataset = await this.repository.getDataset(accountId, projectId, document.id);
					if (!dataset) continue;
					const rows = await this.repository.listRows(accountId, projectId, document.id, 0, dataset.rowCount);
					datasets.push({ documentId: document.id, name: document.displayName, sha256: document.sealedSha256 ?? '', columns: dataset.columns, rows, rejectedRows: dataset.rejectedRows });
				} else {
					const pages = await this.repository.listPages(accountId, projectId, [document.id]);
					pdfs.push({ documentId: document.id, name: document.displayName, sha256: document.sealedSha256 ?? '', pages: pages.map((page) => ({ pageNumber: page.pageNumber, text: page.pageText })) });
				}
			}
			const proposed = analyzeEvidence({ datasets, documents: pdfs });
			const now = this.now();
			const findings = await this.repository.publishRun(run, proposed.map((finding) => ({
				id: this.createId(),
				accountId,
				projectId,
				runId: run.id,
				kind: finding.kind,
				rank: finding.rank,
				title: finding.title.slice(0, 200),
				claim: finding.claim.slice(0, 2000),
				evidence: finding.evidence,
				calculation: finding.calculation,
				limitations: finding.limitations,
				nextQuestion: finding.nextQuestion,
				fingerprint: finding.fingerprint,
				status: 'proposed',
				reviewNote: '',
				dismissalReason: '',
				reviewedBy: null,
				reviewedAt: null,
				createdAt: now,
				updatedAt: now
			})), this.now());
			return { run: { ...run, status: 'succeeded', findingCount: findings.length, finishedAt: this.now() }, findings };
		} catch (error) {
			const failure = error instanceof DocumentError ? error : new DocumentError(500, 'analysis_failed', 'The analysis could not be completed.');
			await this.repository.finishRun(accountId, projectId, run.id, { status: 'failed', findingCount: 0, errorCode: failure.code, errorMessage: failure.message, now: this.now() });
			throw failure;
		}
	}

	async latestRun(accountId: string, projectId: string) {
		return this.repository.latestRun(accountId, projectId);
	}

	async listFindings(accountId: string, projectId: string) {
		return this.repository.listFindings(accountId, projectId);
	}

	/** A reporter's review is an explicit, attributed action on one finding. */
	async reviewFinding(accountId: string, projectId: string, findingId: string, patch: { status: Exclude<FindingStatus, 'stale'>; reviewNote: string; dismissalReason: string }) {
		const existing = await this.repository.getFinding(accountId, projectId, findingId);
		if (!existing) throw new DocumentError(404, 'finding_not_found', 'Lead not found.');
		if (existing.evidence.some((item) => item.withdrawn)) throw new DocumentError(409, 'source_withdrawn', 'This lead cites withdrawn evidence and cannot be reopened.');
		const updated = await this.repository.updateFindingStatus(accountId, projectId, findingId, { ...patch, reviewedBy: accountId, now: this.now() });
		if (!updated) throw new DocumentError(404, 'finding_not_found', 'Lead not found.');
		return updated;
	}

	async verifyCapability(): Promise<void> {
		await Promise.all([this.storage.verifyCapability(), this.extractor.verifyCapability?.() ?? Promise.resolve()]);
	}

	private async requireDocument(accountId: string, projectId: string, documentId: string): Promise<ProjectDocumentRow> {
		const document = await this.repository.getDocument(accountId, projectId, documentId);
		if (!document) throw new DocumentError(404, 'document_not_found', 'File not found.');
		return document;
	}
}

export function publicDocument(row: ProjectDocumentRow): PublicEvidenceDocument {
	return {
		id: row.id,
		projectId: row.projectId,
		kind: row.kind,
		name: row.displayName,
		mimeType: row.mimeType,
		sizeBytes: row.declaredSizeBytes,
		state: row.state,
		sha256: row.sealedSha256,
		pageCount: row.pageCount,
		rowCount: row.rowCount,
		columnCount: row.columnCount,
		error: row.failureMessage,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function hashBytes(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function looksBinary(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 8192);
	if (sample.length >= 4 && sample[0] === 0x50 && sample[1] === 0x4b && sample[2] === 0x03 && sample[3] === 0x04) return true; // zip/xlsx
	if (sample.length >= 2 && sample[0] === 0x4d && sample[1] === 0x5a) return true; // PE
	if (sample.length >= 4 && sample[0] === 0x7f && sample[1] === 0x45 && sample[2] === 0x4c && sample[3] === 0x46) return true; // ELF
	for (const byte of sample) if (byte === 0) return true;
	return false;
}

function queryTerms(query: string): string[] {
	return Array.from(new Set(query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'._-]{2,}/gu) ?? []))
		.filter((term) => !STOP_WORDS.has(term))
		.slice(0, 8);
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'which', 'how', 'many', 'much', 'are', 'was', 'were', 'have', 'has', 'does', 'did', 'about', 'into', 'show', 'tell', 'list', 'find', 'all', 'any', 'you', 'can', 'please', 'rows', 'row', 'file', 'data', 'csv', 'pdf']);

function renderRow(row: DatasetRow, columns: Array<{ name: string }>): string {
	return `row ${row.ordinal}: ${columns.map((column, index) => `${column.name}=${JSON.stringify((row.cells[index] ?? '').slice(0, 120))}`).join('; ')}`;
}
