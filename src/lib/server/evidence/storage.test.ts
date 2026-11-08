import { describe, expect, it, vi } from 'vitest';
import { createVpsDocumentStorage } from '$lib/server/documents/storage';
import { createVpsEvidenceStorage } from './storage';
import { MAX_EVIDENCE_PDF_BYTES } from './constants';

const baseUrl = 'https://storage.example.test';
const pdfBucket = 'fixture-pdf';
const csvBucket = 'fixture-csv';

function fixture(pdfCapability: unknown, csvCapability: unknown) {
	const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === '/v1/policy') {
			const pdf = url.searchParams.get('bucket') === pdfBucket;
			const capability = pdf ? pdfCapability : csvCapability;
			return Response.json({
				private: true,
				maxBytes: MAX_EVIDENCE_PDF_BYTES,
				mimeTypes: [pdf ? 'application/pdf' : 'text/csv'],
				...(capability === undefined ? {} : { supportsUploadRevocation: capability })
			});
		}
		if (url.pathname === '/v1/sign-upload') {
			const request = JSON.parse(String(init?.body));
			return Response.json({ path: request.key, token: 'synthetic-token', signedUrl: `${baseUrl}/v1/upload/synthetic-token` });
		}
		throw new Error('Unexpected synthetic storage request');
	});
	const storage = createVpsEvidenceStorage({ baseUrl, apiKey: 'synthetic-key', pdfBucket, csvBucket, fetchImpl });
	return { storage, fetchImpl };
}

describe('project evidence revocation capability', () => {
	it.each([
		{ name: 'both flags missing', pdf: undefined, csv: undefined },
		{ name: 'PDF flag missing', pdf: undefined, csv: true },
		{ name: 'CSV flag missing', pdf: true, csv: undefined },
		{ name: 'PDF flag false', pdf: false, csv: true },
		{ name: 'CSV flag false', pdf: true, csv: false },
		{ name: 'PDF flag malformed', pdf: 'true', csv: true },
		{ name: 'CSV flag malformed', pdf: true, csv: 1 }
	])('refuses readiness and signing with $name', async ({ pdf, csv }) => {
		const { storage, fetchImpl } = fixture(pdf, csv);
		const failure = { status: 503, code: 'evidence_storage_unavailable' };
		await expect(storage.verifyCapability()).rejects.toMatchObject(failure);
		await expect(storage.createSignedUpload('pdf', 'evidence/account/project/pdf', 10, 'application/pdf')).rejects.toMatchObject(failure);
		await expect(storage.createSignedUpload('csv', 'evidence/account/project/csv', 10, 'text/csv')).rejects.toMatchObject(failure);
		expect(fetchImpl.mock.calls.every(([input]) => new URL(String(input)).pathname === '/v1/policy')).toBe(true);
	});

	it('requires both true flags before signing either evidence type', async () => {
		const { storage, fetchImpl } = fixture(true, true);
		await expect(storage.verifyCapability()).resolves.toBeUndefined();
		for (const kind of ['pdf', 'csv'] as const) {
			fetchImpl.mockClear();
			const contentType = kind === 'pdf' ? 'application/pdf' : 'text/csv';
			await expect(storage.createSignedUpload(kind, `evidence/account/project/${kind}`, 10, contentType)).resolves.toMatchObject({ contentType, token: 'synthetic-token' });
			expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/v1/policy', '/v1/policy', '/v1/sign-upload']);
			expect(fetchImpl.mock.calls.slice(0, 2).map(([input]) => new URL(String(input)).searchParams.get('bucket'))).toEqual([pdfBucket, csvBucket]);
		}
	});

	it.each([undefined, false, true])('preserves conversation PDF policy and upload behavior with capability %s', async (capability) => {
		const { fetchImpl } = fixture(capability, undefined);
		const storage = createVpsDocumentStorage({ baseUrl, apiKey: 'synthetic-key', bucket: pdfBucket, fetchImpl });
		await expect(storage.verifyPrivateBucket()).resolves.toBeUndefined();
		await expect(storage.createSignedUpload('conversation/document/file.pdf')).resolves.toMatchObject({ token: 'synthetic-token' });
		expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/v1/policy', '/v1/sign-upload']);
	});

	it('still requires the exact per-delete acknowledgement after advertised capability succeeds', async () => {
		const { storage, fetchImpl } = fixture(true, true);
		await storage.verifyCapability();
		fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(storage.remove('csv', 'evidence/account/project/csv')).rejects.toMatchObject({ status: 503, code: 'evidence_storage_unavailable' });
		fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'X-NewsCraft-Upload-Revoked': '1' } }));
		await expect(storage.remove('csv', 'evidence/account/project/csv')).resolves.toBeUndefined();
	});
});
