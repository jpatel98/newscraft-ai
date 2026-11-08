import { sql } from '$lib/server/db';
import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { DocumentError } from '$lib/server/documents/errors';
import { ANALYSIS_RUN_STALE_MS, PROCESSING_CLAIM_STALE_MS, MAX_DOCUMENTS_PER_PROJECT, MAX_PROJECT_SOURCE_BYTES,
	MAX_ANALYSIS_SOURCE_BYTES, MAX_ANALYSIS_CELLS, MAX_ANALYSIS_PAGES, MAX_ANALYSIS_EXTRACTED_CHARS } from './constants';
import type {
	AnalysisRunRow,
	DatasetRow,
	EvidenceRepository,
	ProjectDatasetRow,
	ProjectDocumentPageRow,
	ProjectDocumentRow,
	ProjectFindingRow,
	RankedProjectPage
} from './types';

/**
 * Every statement here names account_id AND project_id in its predicate. The
 * composite foreign keys in 0027 enforce the same binding at the database, so
 * a forged document id from another project matches nothing even if a caller
 * forgets a predicate.
 */
export function createPostgresEvidenceRepository(): EvidenceRepository {
	const repository: EvidenceRepository = {
		async reserveDocuments(accountId, projectId, rows) {
			await sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				if (rows.some((row) => row.accountId !== accountId || row.projectId !== projectId || row.state !== 'uploading')) throw new Error('EVIDENCE_SCOPE_MISMATCH');
				const [usage] = await tx`SELECT count(*)::int AS count, coalesce(sum(declared_size_bytes), 0)::bigint AS bytes
					FROM project_documents WHERE account_id = ${accountId} AND project_id = ${projectId}`;
				if (Number(usage.count) + rows.length > MAX_DOCUMENTS_PER_PROJECT) throw new DocumentError(409, 'project_document_limit', 'This project has reached its evidence file limit.');
				if (Number(usage.bytes) + rows.reduce((sum, row) => sum + row.declaredSizeBytes, 0) > MAX_PROJECT_SOURCE_BYTES) throw new DocumentError(409, 'project_storage_limit', 'This project has reached its 1 GB evidence limit.');
				for (const row of rows) await insertDocument(tx, row);
			});
		},

		async deleteProject(accountId, projectId) {
			await sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				const [document] = await tx`SELECT id FROM project_documents WHERE account_id = ${accountId} AND project_id = ${projectId} LIMIT 1`;
				if (document) throw new DocumentError(409, 'project_has_evidence', 'Remove all evidence before deleting this project.');
				await tx`DELETE FROM projects WHERE id = ${projectId} AND account_id = ${accountId}`;
			});
		},

		async createDocument(row) {
			await repository.reserveDocuments(row.accountId, row.projectId, [row]);
		},

		async getDocument(accountId, projectId, documentId) {
			const [row] = await sql`SELECT ${DOCUMENT_COLUMNS} FROM project_documents
				WHERE id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}`;
			return row ? documentRow(row) : undefined;
		},

		async listDocuments(accountId, projectId) {
			const rows = await sql`SELECT ${DOCUMENT_COLUMNS} FROM project_documents
				WHERE account_id = ${accountId} AND project_id = ${projectId} ORDER BY created_at ASC, id ASC`;
			return rows.map(documentRow);
		},

		async projectUsage(accountId, projectId) {
			const [row] = await sql`SELECT count(*)::int AS count, coalesce(sum(declared_size_bytes), 0)::bigint AS bytes
				FROM project_documents WHERE account_id = ${accountId} AND project_id = ${projectId}`;
			return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
		},

		async claimForProcessing(accountId, projectId, documentId, now) {
			return sql.begin(async (tx) => {
			await lockProject(tx, accountId, projectId);
			const [row] = await tx`UPDATE project_documents SET state = 'processing', processing_started_at = ${now}, processing_token = ${randomUUID()},
				processed_at = NULL, failure_code = NULL, failure_message = NULL, updated_at = ${now}
				WHERE id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}
				AND (state IN ('uploading', 'failed') OR (state = 'processing' AND processing_started_at <= ${now - PROCESSING_CLAIM_STALE_MS})) RETURNING ${DOCUMENT_COLUMNS}`;
			return row ? documentRow(row) : undefined;
			});
		},

		async markFailed(document, failure) {
			const { accountId, projectId, id: documentId } = document;
			await sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				if (!await ownsClaim(tx, document)) return;
				await tx`DELETE FROM project_document_pages WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}`;
				await tx`DELETE FROM project_dataset_rows WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}`;
				await tx`DELETE FROM project_datasets WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}`;
				await tx`UPDATE project_documents SET state = 'failed', processing_token = NULL, page_count = NULL, row_count = NULL, column_count = NULL,
					failure_code = ${failure.code}, failure_message = ${failure.message}, processed_at = ${failure.now}, updated_at = ${failure.now}
					WHERE id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId} AND state = 'processing'`;
			});
		},

		async sealPdf(document, seal) {
			return sql.begin(async (tx) => {
				await lockProject(tx, document.accountId, document.projectId);
				if (!await ownsClaim(tx, document)) throw claimLost();
				await tx`DELETE FROM project_document_pages WHERE document_id = ${document.id} AND account_id = ${document.accountId} AND project_id = ${document.projectId}`;
				for (let index = 0; index < seal.pages.length; index += 200) {
					const batch = seal.pages.slice(index, index + 200).map((pageText, offset) => ({
						id: `${document.id}:${index + offset + 1}`,
						document_id: document.id,
						account_id: document.accountId,
						project_id: document.projectId,
						page_number: index + offset + 1,
						page_text: pageText,
						char_count: pageText.length,
						created_at: seal.now
					}));
					if (batch.length) await tx`INSERT INTO project_document_pages ${tx(batch)}`;
				}
				const [row] = await tx`UPDATE project_documents SET state = 'ready', processing_token = NULL, extracted_chars = ${seal.pages.reduce((sum, page) => sum + page.length, 0)}, sealed_sha256 = ${seal.sha256}, sealed_size_bytes = ${seal.sizeBytes},
					sealed_at = ${seal.now}, extraction_version = extraction_version + 1, page_count = ${seal.pages.length}, row_count = NULL, column_count = NULL,
					failure_code = NULL, failure_message = NULL, processed_at = ${seal.now}, updated_at = ${seal.now}
					WHERE id = ${document.id} AND account_id = ${document.accountId} AND project_id = ${document.projectId} AND state = 'processing'
					RETURNING ${DOCUMENT_COLUMNS}`;
				if (!row) throw new Error('EVIDENCE_SEAL_LOST');
				return documentRow(row);
			});
		},

		async sealCsv(document, seal) {
			return sql.begin(async (tx) => {
				await lockProject(tx, document.accountId, document.projectId);
				if (!await ownsClaim(tx, document)) throw claimLost();
				await tx`DELETE FROM project_dataset_rows WHERE document_id = ${document.id} AND account_id = ${document.accountId} AND project_id = ${document.projectId}`;
				await tx`DELETE FROM project_datasets WHERE document_id = ${document.id} AND account_id = ${document.accountId} AND project_id = ${document.projectId}`;
				await tx`INSERT INTO project_datasets (document_id, account_id, project_id, delimiter, has_header, encoding, parser_version, columns, row_count, rejected_rows, created_at)
					VALUES (${document.id}, ${document.accountId}, ${document.projectId}, ${seal.dataset.delimiter}, ${seal.dataset.hasHeader}, ${seal.dataset.encoding},
					${seal.dataset.parserVersion}, ${JSON.stringify(seal.dataset.columns)}::jsonb, ${seal.dataset.rowCount}, ${seal.dataset.rejectedRows}, ${seal.now})`;
				for (let index = 0; index < seal.rows.length; index += 500) {
					const batch = seal.rows.slice(index, index + 500).map((row) => ({
						document_id: document.id,
						account_id: document.accountId,
						project_id: document.projectId,
						ordinal: row.ordinal,
						source_line: row.sourceLine,
						cells: row.cells
					}));
					if (batch.length) await tx`INSERT INTO project_dataset_rows ${tx(batch)}`;
				}
				const [row] = await tx`UPDATE project_documents SET state = 'ready', processing_token = NULL, sealed_sha256 = ${seal.sha256}, sealed_size_bytes = ${seal.sizeBytes},
					sealed_at = ${seal.now}, extraction_version = extraction_version + 1, page_count = NULL, row_count = ${seal.dataset.rowCount},
					column_count = ${seal.dataset.columns.length}, failure_code = NULL, failure_message = NULL, processed_at = ${seal.now}, updated_at = ${seal.now}
					WHERE id = ${document.id} AND account_id = ${document.accountId} AND project_id = ${document.projectId} AND state = 'processing'
					RETURNING ${DOCUMENT_COLUMNS}`;
				if (!row) throw new Error('EVIDENCE_SEAL_LOST');
				return documentRow(row);
			});
		},

		async deleteDocument(accountId, projectId, documentId) {
			await sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				await tx`DELETE FROM project_documents WHERE id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId} AND state = 'deleting'`;
			});
		},

		async beginDelete(accountId, projectId, documentId, now) {
			return sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				const [row] = await tx`UPDATE project_documents SET state = 'deleting', processing_token = NULL, updated_at = ${now}
					WHERE id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId} RETURNING ${DOCUMENT_COLUMNS}`;
				if (!row) return undefined;
				await withdraw(tx, accountId, projectId, documentId, now);
				await tx`DELETE FROM project_document_pages WHERE account_id = ${accountId} AND project_id = ${projectId} AND document_id = ${documentId}`;
				await tx`DELETE FROM project_dataset_rows WHERE account_id = ${accountId} AND project_id = ${projectId} AND document_id = ${documentId}`;
				await tx`DELETE FROM project_datasets WHERE account_id = ${accountId} AND project_id = ${projectId} AND document_id = ${documentId}`;
				await tx`UPDATE project_analysis_runs SET status = 'cancelled', finished_at = ${now}, error_code = 'evidence_changed', error_message = 'Evidence changed during analysis.'
					WHERE account_id = ${accountId} AND project_id = ${projectId} AND status = 'running'
					AND EXISTS (SELECT 1 FROM jsonb_array_elements(input_documents) AS source WHERE source->>'id' = ${documentId})`;
				return documentRow(row);
			});
		},

		async getPage(accountId, projectId, documentId, pageNumber) {
			const [row] = await sql`SELECT document_id AS "documentId", page_number AS "pageNumber", page_text AS "pageText", char_count AS "charCount"
				FROM project_document_pages WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId} AND page_number = ${pageNumber}`;
			return row as ProjectDocumentPageRow | undefined;
		},

		async listPages(accountId, projectId, documentIds) {
			if (documentIds.length === 0) return [];
			const rows = await sql`SELECT document_id AS "documentId", page_number AS "pageNumber", page_text AS "pageText", char_count AS "charCount"
				FROM project_document_pages WHERE account_id = ${accountId} AND project_id = ${projectId} AND document_id IN ${sql(documentIds)}
				ORDER BY document_id ASC, page_number ASC`;
			return rows as unknown as ProjectDocumentPageRow[];
		},

		async searchPages(accountId, projectId, documentIds, query, limit) {
			const normalized = query.trim();
			if (documentIds.length === 0 || limit < 1 || !normalized) return [];
			const rows = await sql`SELECT document_id AS "documentId", page_number AS "pageNumber", page_text AS "pageText", char_count AS "charCount",
				ts_rank(search_vector, plainto_tsquery('simple', ${normalized}))::float8 AS rank
				FROM project_document_pages WHERE account_id = ${accountId} AND project_id = ${projectId} AND document_id IN ${sql(documentIds)}
				AND search_vector @@ plainto_tsquery('simple', ${normalized})
				ORDER BY rank DESC, document_id ASC, page_number ASC LIMIT ${limit}`;
			return rows as unknown as RankedProjectPage[];
		},

		async listPagesPrefix(accountId, projectId, documentIds, limit) {
			if (documentIds.length === 0 || limit < 1) return [];
			const rows = await sql`SELECT document_id AS "documentId", page_number AS "pageNumber", page_text AS "pageText", char_count AS "charCount"
				FROM project_document_pages WHERE account_id = ${accountId} AND project_id = ${projectId} AND document_id IN ${sql(documentIds)}
				ORDER BY document_id ASC, page_number ASC LIMIT ${limit}`;
			return rows as unknown as ProjectDocumentPageRow[];
		},

		async getDataset(accountId, projectId, documentId) {
			const [row] = await sql`SELECT document_id AS "documentId", delimiter, has_header AS "hasHeader", encoding, parser_version AS "parserVersion",
				columns, row_count AS "rowCount", rejected_rows AS "rejectedRows"
				FROM project_datasets WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}`;
			return row as ProjectDatasetRow | undefined;
		},

		async listRows(accountId, projectId, documentId, offset, limit) {
			if (limit < 1) return [];
			const rows = await sql`SELECT ordinal, source_line AS "sourceLine", cells FROM project_dataset_rows
				WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}
				ORDER BY ordinal ASC OFFSET ${Math.max(0, offset)} LIMIT ${limit}`;
			return rows as unknown as DatasetRow[];
		},

		async listRowsByOrdinals(accountId, projectId, documentId, ordinals) {
			const unique = Array.from(new Set(ordinals.filter((value) => Number.isInteger(value) && value > 0)));
			if (unique.length === 0) return [];
			const rows = await sql`SELECT ordinal, source_line AS "sourceLine", cells FROM project_dataset_rows
				WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId} AND ordinal IN ${sql(unique)}
				ORDER BY ordinal ASC`;
			return rows as unknown as DatasetRow[];
		},

		async searchRows(accountId, projectId, documentId, terms, limit) {
			const cleaned = terms.map((term) => term.trim()).filter((term) => term.length >= 2).slice(0, 6);
			if (cleaned.length === 0 || limit < 1) return [];
			const patterns = cleaned.map((term) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
			const rows = await sql`SELECT ordinal, source_line AS "sourceLine", cells FROM project_dataset_rows
				WHERE document_id = ${documentId} AND account_id = ${accountId} AND project_id = ${projectId}
				AND EXISTS (SELECT 1 FROM unnest(cells) AS cell WHERE cell ILIKE ANY (${patterns}::text[]))
				ORDER BY ordinal ASC LIMIT ${limit}`;
			return rows as unknown as DatasetRow[];
		},

		async createRun(run) {
			await repository.startRun(run);
		},

		async startRun(run) {
			return sql.begin(async (tx) => {
				await lockProject(tx, run.accountId, run.projectId);
				await tx`UPDATE project_analysis_runs SET status = 'cancelled', finished_at = ${run.startedAt}, error_code = 'analysis_expired', error_message = 'The previous analysis expired.'
					WHERE account_id = ${run.accountId} AND project_id = ${run.projectId} AND status = 'running' AND started_at <= ${run.startedAt - ANALYSIS_RUN_STALE_MS}`;
				const [active] = await tx`SELECT id FROM project_analysis_runs WHERE account_id = ${run.accountId} AND project_id = ${run.projectId} AND status = 'running'`;
				if (active) throw new DocumentError(409, 'analysis_running', 'An analysis is already running for this project.');
				const rows = await tx`SELECT ${DOCUMENT_COLUMNS} FROM project_documents WHERE account_id = ${run.accountId} AND project_id = ${run.projectId} AND state = 'ready' ORDER BY id`;
				const documents = rows.map(documentRow);
				if (!documents.length) throw new DocumentError(409, 'no_ready_evidence', 'Add at least one processed PDF or CSV before analyzing.');
				assertAnalysisBudget(documents);
				const inputs = documents.map((document) => ({ id: document.id, sha256: document.sealedSha256, extractionVersion: document.extractionVersion }));
				await tx`INSERT INTO project_analysis_runs (id, account_id, project_id, status, trigger, analyzer_version, input_documents, finding_count, started_at)
					VALUES (${run.id}, ${run.accountId}, ${run.projectId}, 'running', ${run.trigger}, ${run.analyzerVersion}, ${JSON.stringify(inputs)}::jsonb, 0, ${run.startedAt})`;
				return documents;
			});
		},

		async publishRun(run, findings, now) {
			return sql.begin(async (tx) => {
				await lockProject(tx, run.accountId, run.projectId);
				const [stored] = await tx`SELECT ${RUN_COLUMNS} FROM project_analysis_runs WHERE id = ${run.id} AND account_id = ${run.accountId} AND project_id = ${run.projectId} AND status = 'running'`;
				if (!stored || now - Number(stored.startedAt) >= ANALYSIS_RUN_STALE_MS) throw analysisChanged();
				const inputs = (stored.inputDocuments as AnalysisRunRow['inputDocuments']);
				const rows = await tx`SELECT ${DOCUMENT_COLUMNS} FROM project_documents WHERE account_id = ${run.accountId} AND project_id = ${run.projectId} AND state = 'ready'`;
				const documents = new Map(rows.map((row) => [String(row.id), documentRow(row)]));
				if (inputs.some((input) => {
					const document = documents.get(input.id);
					return !document || document.sealedSha256 !== input.sha256 || document.extractionVersion !== input.extractionVersion;
				})) throw analysisChanged();
				if (findings.some((finding) => finding.runId !== run.id || finding.evidence.some((item) => !inputs.some((input) => input.id === item.documentId && input.sha256 === item.sha256)))) throw analysisChanged();
				const saved = await saveFindings(tx, run.accountId, run.projectId, findings);
				await tx`UPDATE project_analysis_runs SET status = 'succeeded', finding_count = ${saved.length}, finished_at = ${now}
					WHERE id = ${run.id} AND account_id = ${run.accountId} AND project_id = ${run.projectId} AND status = 'running'`;
				return saved;
			});
		},

		async finishRun(accountId, projectId, runId, result) {
			await sql`UPDATE project_analysis_runs SET status = ${result.status}, finding_count = ${result.findingCount},
				error_code = ${result.errorCode ?? null}, error_message = ${result.errorMessage ?? null}, finished_at = ${result.now}
				WHERE id = ${runId} AND account_id = ${accountId} AND project_id = ${projectId} AND status = 'running'`;
		},

		async latestRun(accountId, projectId) {
			const [row] = await sql`SELECT ${RUN_COLUMNS} FROM project_analysis_runs WHERE account_id = ${accountId} AND project_id = ${projectId}
				ORDER BY started_at DESC, id DESC LIMIT 1`;
			return row ? runRow(row) : undefined;
		},

		async listFindings(accountId, projectId) {
			const rows = await sql`SELECT ${FINDING_COLUMNS} FROM project_findings WHERE account_id = ${accountId} AND project_id = ${projectId}
				ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'saved' THEN 1 WHEN 'reviewed' THEN 2 WHEN 'stale' THEN 3 ELSE 4 END, rank ASC, created_at DESC, id ASC`;
			return rows.map(findingRow);
		},

		async getFinding(accountId, projectId, findingId) {
			const [row] = await sql`SELECT ${FINDING_COLUMNS} FROM project_findings WHERE id = ${findingId} AND account_id = ${accountId} AND project_id = ${projectId}`;
			return row ? findingRow(row) : undefined;
		},

		async upsertFindings(accountId, projectId, findings) {
			return sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				return saveFindings(tx, accountId, projectId, findings);
			});
		},

		async updateFindingStatus(accountId, projectId, findingId, patch) {
			const reviewed = patch.status === 'reviewed' || patch.status === 'dismissed' || patch.status === 'saved';
			const [row] = await sql`UPDATE project_findings SET status = ${patch.status},
				review_note = ${patch.reviewNote ?? ''}, dismissal_reason = ${patch.status === 'dismissed' ? patch.dismissalReason ?? '' : ''},
				reviewed_by = ${reviewed ? patch.reviewedBy : null}, reviewed_at = ${reviewed ? patch.now : null}, updated_at = ${patch.now}
				WHERE id = ${findingId} AND account_id = ${accountId} AND project_id = ${projectId}
				AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) AS item WHERE item->>'withdrawn' = 'true') RETURNING ${FINDING_COLUMNS}`;
			return row ? findingRow(row) : undefined;
		},

		async withdrawDocumentFromFindings(accountId, projectId, documentId, now) {
			await sql.begin(async (tx) => {
				await lockProject(tx, accountId, projectId);
				await withdraw(tx, accountId, projectId, documentId, now);
			});
		}
	};
	return repository;
}

async function lockProject(tx: TransactionSql, accountId: string, projectId: string) {
	const [project] = await tx`SELECT id FROM projects WHERE id = ${projectId} AND account_id = ${accountId} FOR UPDATE`;
	if (!project) throw new DocumentError(404, 'project_not_found', 'Project not found.');
}

async function insertDocument(tx: TransactionSql, row: ProjectDocumentRow) {
	await tx`INSERT INTO project_documents (id, account_id, project_id, org_id, kind, display_name, mime_type,
		declared_size_bytes, declared_sha256, storage_bucket, storage_path, state, extraction_version, created_at, updated_at)
		VALUES (${row.id}, ${row.accountId}, ${row.projectId}, ${row.orgId}, ${row.kind}, ${row.displayName}, ${row.mimeType},
		${row.declaredSizeBytes}, ${row.declaredSha256}, ${row.storageBucket}, ${row.storagePath}, 'uploading', 0, ${row.createdAt}, ${row.updatedAt})`;
}

function claimLost() {
	return new DocumentError(409, 'processing_claim_lost', 'This processing attempt is no longer current. Retry the request.');
}

async function ownsClaim(tx: TransactionSql, document: ProjectDocumentRow) {
	if (!document.processingToken) return false;
	const [row] = await tx`SELECT id FROM project_documents WHERE id = ${document.id} AND account_id = ${document.accountId}
		AND project_id = ${document.projectId} AND state = 'processing' AND processing_token = ${document.processingToken} FOR UPDATE`;
	return Boolean(row);
}

function analysisChanged() {
	return new DocumentError(409, 'evidence_changed', 'Evidence changed or this analysis expired. Run analysis again.');
}

export function assertAnalysisBudget(documents: ProjectDocumentRow[]) {
	const sourceBytes = documents.reduce((sum, document) => sum + document.declaredSizeBytes, 0);
	const cells = documents.reduce((sum, document) => sum + (document.rowCount ?? 0) * (document.columnCount ?? 0), 0);
	const pages = documents.reduce((sum, document) => sum + (document.pageCount ?? 0), 0);
	const chars = documents.reduce((sum, document) => sum + document.extractedChars, 0);
	if (sourceBytes > MAX_ANALYSIS_SOURCE_BYTES || cells > MAX_ANALYSIS_CELLS || pages > MAX_ANALYSIS_PAGES || chars > MAX_ANALYSIS_EXTRACTED_CHARS) {
		throw new DocumentError(413, 'analysis_limit_exceeded', 'Evidence exceeds the analysis limit. Use a smaller project before analyzing.');
	}
}

async function saveFindings(tx: TransactionSql, accountId: string, projectId: string, findings: ProjectFindingRow[]) {
	const saved: ProjectFindingRow[] = [];
	const documents = await tx`SELECT id, sealed_sha256 FROM project_documents WHERE account_id = ${accountId} AND project_id = ${projectId} AND state = 'ready'`;
	for (const finding of findings) {
		if (finding.accountId !== accountId || finding.projectId !== projectId) throw new Error('EVIDENCE_SCOPE_MISMATCH');
		if (finding.evidence.some((item) => item.withdrawn || !documents.some((document) => document.id === item.documentId && document.sealed_sha256 === item.sha256))) throw analysisChanged();
		const [row] = await tx`INSERT INTO project_findings (id, account_id, project_id, run_id, kind, rank, title, claim, evidence, calculation,
			limitations, next_question, fingerprint, status, created_at, updated_at)
			VALUES (${finding.id}, ${accountId}, ${projectId}, ${finding.runId}, ${finding.kind}, ${finding.rank}, ${finding.title}, ${finding.claim},
			${JSON.stringify(finding.evidence)}::jsonb, ${JSON.stringify(finding.calculation)}::jsonb, ${finding.limitations}, ${finding.nextQuestion},
			${finding.fingerprint}, ${finding.status}, ${finding.createdAt}, ${finding.updatedAt})
			ON CONFLICT (project_id, fingerprint) DO UPDATE SET
				run_id = EXCLUDED.run_id, rank = EXCLUDED.rank, title = EXCLUDED.title, claim = EXCLUDED.claim, evidence = EXCLUDED.evidence,
				calculation = EXCLUDED.calculation, limitations = EXCLUDED.limitations, next_question = EXCLUDED.next_question, updated_at = EXCLUDED.updated_at
			WHERE project_findings.account_id = ${accountId} AND project_findings.status = 'proposed' AND project_findings.reviewed_by IS NULL
			RETURNING ${FINDING_COLUMNS}`;
		if (row) saved.push(findingRow(row));
		else {
			const [existing] = await tx`SELECT ${FINDING_COLUMNS} FROM project_findings WHERE account_id = ${accountId} AND project_id = ${projectId} AND fingerprint = ${finding.fingerprint}`;
			if (existing) saved.push(findingRow(existing));
		}
	}
	return saved;
}

async function withdraw(tx: TransactionSql, accountId: string, projectId: string, documentId: string, now: number) {
	await tx`UPDATE project_findings SET
		evidence = (SELECT coalesce(jsonb_agg(CASE WHEN item->>'documentId' = ${documentId}
			THEN jsonb_build_object('documentId', item->'documentId', 'documentName', item->'documentName', 'sha256', item->'sha256',
				'kind', item->'kind', 'withdrawn', true) ELSE item END ORDER BY ord), '[]'::jsonb)
			FROM jsonb_array_elements(evidence) WITH ORDINALITY AS source(item, ord)),
		status = CASE WHEN status = 'dismissed' THEN status ELSE 'stale' END, updated_at = ${now}
		WHERE account_id = ${accountId} AND project_id = ${projectId}
		AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) AS item WHERE item->>'documentId' = ${documentId})`;
}

const DOCUMENT_COLUMNS = sql`id, account_id AS "accountId", project_id AS "projectId", org_id AS "orgId", kind, display_name AS "displayName",
	mime_type AS "mimeType", declared_size_bytes AS "declaredSizeBytes", declared_sha256 AS "declaredSha256", storage_bucket AS "storageBucket",
	storage_path AS "storagePath", state, sealed_sha256 AS "sealedSha256", sealed_size_bytes AS "sealedSizeBytes", sealed_at AS "sealedAt",
	extraction_version AS "extractionVersion", page_count AS "pageCount", row_count AS "rowCount", column_count AS "columnCount",
	failure_code AS "failureCode", failure_message AS "failureMessage", processing_started_at AS "processingStartedAt", processing_token AS "processingToken", extracted_chars AS "extractedChars", processed_at AS "processedAt",
	created_at AS "createdAt", updated_at AS "updatedAt"`;

const RUN_COLUMNS = sql`id, account_id AS "accountId", project_id AS "projectId", status, trigger, analyzer_version AS "analyzerVersion",
	input_documents AS "inputDocuments", finding_count AS "findingCount", error_code AS "errorCode", error_message AS "errorMessage",
	started_at AS "startedAt", finished_at AS "finishedAt"`;

const FINDING_COLUMNS = sql`id, account_id AS "accountId", project_id AS "projectId", run_id AS "runId", kind, rank, title, claim, evidence, calculation,
	limitations, next_question AS "nextQuestion", fingerprint, status, review_note AS "reviewNote", dismissal_reason AS "dismissalReason",
	reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

function num(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function documentRow(row: Record<string, unknown>): ProjectDocumentRow {
	return {
		...(row as unknown as ProjectDocumentRow),
		declaredSizeBytes: Number(row.declaredSizeBytes),
		sealedSizeBytes: num(row.sealedSizeBytes),
		sealedAt: num(row.sealedAt),
		extractionVersion: Number(row.extractionVersion),
		pageCount: num(row.pageCount),
		rowCount: num(row.rowCount),
		columnCount: num(row.columnCount),
		processingStartedAt: num(row.processingStartedAt),
		extractedChars: Number(row.extractedChars ?? 0),
		processedAt: num(row.processedAt),
		createdAt: Number(row.createdAt),
		updatedAt: Number(row.updatedAt)
	};
}

function runRow(row: Record<string, unknown>): AnalysisRunRow {
	return {
		...(row as unknown as AnalysisRunRow),
		findingCount: Number(row.findingCount),
		startedAt: Number(row.startedAt),
		finishedAt: num(row.finishedAt)
	};
}

function findingRow(row: Record<string, unknown>): ProjectFindingRow {
	return {
		...(row as unknown as ProjectFindingRow),
		rank: Number(row.rank),
		reviewedAt: num(row.reviewedAt),
		createdAt: Number(row.createdAt),
		updatedAt: Number(row.updatedAt)
	};
}

