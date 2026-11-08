import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentError } from '$lib/server/documents/errors';

const projectMocks = vi.hoisted(() => ({ getProject: vi.fn() }));
const serviceMocks = vi.hoisted(() => ({
	listDocuments: vi.fn(),
	createUploadIntents: vi.fn(),
	finalizeDocument: vi.fn(),
	createDownloadUrl: vi.fn(),
	deleteDocument: vi.fn(),
	getDocument: vi.fn(),
	getPage: vi.fn(),
	getRows: vi.fn(),
	runAnalysis: vi.fn(),
	latestRun: vi.fn(),
	listFindings: vi.fn(),
	reviewFinding: vi.fn()
}));
const privateEnv = vi.hoisted(() => ({
	NEWSCRAFT_STORAGE_PROVIDER: 'vps' as string | undefined,
	NEWSCRAFT_STORAGE_MODE: undefined as string | undefined,
	NEWSCRAFT_STORAGE_BASE_URL: 'https://storage.example/newscraft-storage' as string | undefined,
	SUPABASE_URL: undefined as string | undefined
}));

vi.mock('$lib/server/db/projects', () => projectMocks);
vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));
vi.mock('$lib/server/evidence/runtime', () => ({
	getProjectEvidenceService: () => serviceMocks,
	isMissingEvidenceTablesError: (error: unknown) => (error as { code?: string })?.code === '42P01',
	evidenceTablesReady: async () => true
}));

import { GET as listEvidence, POST as createIntents } from './+server';
import { DELETE as deleteEvidence, GET as readEvidence } from './[documentId]/+server';
import { GET as downloadEvidence } from './[documentId]/download/+server';
import { POST as finalizeEvidence } from './[documentId]/finalize/+server';
import { POST as runAnalysis } from '../analysis/+server';
import { PATCH as patchFinding } from '../findings/[findingId]/+server';

const user = { id: 'acct-a', email: 'reporter@example.test', name: 'Reporter', role: 'member' as const };

function event(options: { authenticated?: boolean; body?: unknown; projectId?: string; url?: string } = {}) {
	const projectId = options.projectId ?? 'proj-a';
	return {
		params: { id: projectId, documentId: 'doc-1', findingId: 'finding-1' },
		locals: { user: options.authenticated === false ? null : user, traceId: 'trace-1', isMarketingHost: false },
		url: new URL(options.url ?? `http://localhost/api/projects/${projectId}/evidence/doc-1`),
		request: new Request(`http://localhost/api/projects/${projectId}/evidence`, {
			method: 'POST',
			body: options.body === undefined ? undefined : JSON.stringify(options.body)
		})
	} as any;
}

describe('project evidence routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		projectMocks.getProject.mockImplementation(async (accountId: string, id: string) => (accountId === 'acct-a' && id === 'proj-a' ? { id, name: 'Budget' } : undefined));
		serviceMocks.listDocuments.mockResolvedValue([]);
		serviceMocks.createUploadIntents.mockResolvedValue([]);
		serviceMocks.finalizeDocument.mockResolvedValue({ id: 'doc-1', state: 'ready' });
		serviceMocks.createDownloadUrl.mockResolvedValue('https://storage.example/newscraft-storage/v1/download/token');
		serviceMocks.getDocument.mockResolvedValue({ id: 'doc-1' });
		serviceMocks.reviewFinding.mockResolvedValue({ id: 'finding-1', status: 'dismissed' });
		serviceMocks.runAnalysis.mockResolvedValue({ run: { id: 'run-1' }, findings: [] });
	});

	it('requires a session and an owned project; a foreign or forged project id is a 404 before any service call', async () => {
		await expect(listEvidence(event({ authenticated: false }))).rejects.toMatchObject({ status: 401 });
		await expect(listEvidence(event({ projectId: 'proj-of-someone-else' }))).rejects.toMatchObject({ status: 404 });
		await expect(finalizeEvidence(event({ projectId: 'proj-of-someone-else' }))).rejects.toMatchObject({ status: 404 });
		await expect(downloadEvidence(event({ projectId: 'proj-of-someone-else' }))).rejects.toMatchObject({ status: 404 });
		await expect(deleteEvidence(event({ projectId: 'proj-of-someone-else' }))).rejects.toMatchObject({ status: 404 });
		await expect(runAnalysis(event({ projectId: 'proj-of-someone-else' }))).rejects.toMatchObject({ status: 404 });
		await expect(patchFinding(event({ projectId: 'proj-of-someone-else', body: { status: 'saved' } }))).rejects.toMatchObject({ status: 404 });
		expect(serviceMocks.listDocuments).not.toHaveBeenCalled();
		expect(serviceMocks.finalizeDocument).not.toHaveBeenCalled();
		expect(serviceMocks.createDownloadUrl).not.toHaveBeenCalled();
		expect(serviceMocks.deleteDocument).not.toHaveBeenCalled();
		expect(serviceMocks.runAnalysis).not.toHaveBeenCalled();
		expect(serviceMocks.reviewFinding).not.toHaveBeenCalled();
	});

	it('takes the project from the session and path, never from the body', async () => {
		const response = await createIntents(event({
			body: { projectId: 'proj-of-someone-else', accountId: 'acct-b', documents: [{ filename: 'vendors.csv', mimeType: 'text/csv', sizeBytes: 10, checksumSha256: 'a'.repeat(64) }] }
		}));
		expect(response.status).toBe(201);
		expect(serviceMocks.createUploadIntents).toHaveBeenCalledWith(
			{ id: 'proj-a', accountId: 'acct-a', orgId: null },
			[expect.objectContaining({ filename: 'vendors.csv', kind: 'csv', storedMimeType: 'text/csv' })]
		);
	});

	it('rejects unsupported file types and bad declarations before touching storage', async () => {
		await expect(createIntents(event({ body: { documents: [{ filename: 'macro.xlsm', mimeType: 'application/vnd.ms-excel', sizeBytes: 10, checksumSha256: 'a'.repeat(64) }] } }))).rejects.toMatchObject({ status: 415 });
		await expect(createIntents(event({ body: { documents: [{ filename: '../escape.csv', mimeType: 'text/csv', sizeBytes: 10, checksumSha256: 'a'.repeat(64) }] } }))).rejects.toMatchObject({ status: 400 });
		await expect(createIntents(event({ body: { documents: [{ filename: 'big.pdf', mimeType: 'application/pdf', sizeBytes: 30 * 1024 * 1024, checksumSha256: 'a'.repeat(64) }] } }))).rejects.toMatchObject({ status: 413 });
		expect(serviceMocks.createUploadIntents).not.toHaveBeenCalled();
	});

	it('redirects downloads only to the configured storage origin, uncached and without a referrer', async () => {
		const response = await downloadEvidence(event());
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('https://storage.example/newscraft-storage/v1/download/token');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		serviceMocks.createDownloadUrl.mockResolvedValue('https://attacker.example/v1/download/token');
		await expect(downloadEvidence(event())).rejects.toMatchObject({ status: 503 });
	});

	it('maps domain errors to their HTTP status and hides the missing-table case behind 503', async () => {
		serviceMocks.finalizeDocument.mockRejectedValue(new DocumentError(422, 'file_mismatch', 'The uploaded bytes did not match the selected file. Upload it again.'));
		await expect(finalizeEvidence(event())).rejects.toMatchObject({ status: 422 });
		serviceMocks.listDocuments.mockRejectedValue(Object.assign(new Error('relation "project_documents" does not exist'), { code: '42P01' }));
		await expect(listEvidence(event())).rejects.toMatchObject({ status: 503 });
	});

	it('validates row and page queries and passes bounded values through', async () => {
		serviceMocks.getRows.mockResolvedValue({ rows: [] });
		await readEvidence(event({ url: 'http://localhost/api/projects/proj-a/evidence/doc-1?rows=1&offset=25&limit=25' }));
		expect(serviceMocks.getRows).toHaveBeenCalledWith('acct-a', 'proj-a', 'doc-1', { offset: 25, limit: 25, ordinals: undefined });
		await expect(readEvidence(event({ url: 'http://localhost/api/projects/proj-a/evidence/doc-1?rows=1&limit=5000' }))).rejects.toMatchObject({ status: 400 });
		await expect(readEvidence(event({ url: 'http://localhost/api/projects/proj-a/evidence/doc-1?page=abc' }))).rejects.toMatchObject({ status: 400 });
	});

	it('requires a reason to dismiss a lead', async () => {
		await expect(patchFinding(event({ body: { status: 'dismissed' } }))).rejects.toMatchObject({ status: 400 });
		const response = await patchFinding(event({ body: { status: 'dismissed', dismissalReason: 'Expected in this data' } }));
		expect(response.status).toBe(200);
		expect(serviceMocks.reviewFinding).toHaveBeenCalledWith('acct-a', 'proj-a', 'finding-1', { status: 'dismissed', reviewNote: '', dismissalReason: 'Expected in this data' });
	});
});

