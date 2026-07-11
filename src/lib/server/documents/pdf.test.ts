import { describe, expect, it, vi } from 'vitest';
import { createUnpdfExtractor, hasPdfSignature, type UnpdfModule } from './pdf';

describe('unpdf adapter', () => {
	it('extracts text from a real multi-page PDF fixture', async () => {
		const result = await createUnpdfExtractor().extract(
			textPdfFixture([
				'Council approved the housing motion.',
				'The recorded vote was eight to three.'
			])
		);
		expect(result.pageCount).toBe(2);
		expect(result.pages[0]).toContain('Council approved the housing motion.');
		expect(result.pages[1]).toContain('The recorded vote was eight to three.');
	});

	it('rejects real encrypted, image-only, and 251-page PDF fixtures safely', async () => {
		const extractor = createUnpdfExtractor();
		await expect(extractor.extract(encryptedPdfFixture())).rejects.toMatchObject({
			code: 'encrypted_pdf',
			message: 'Password-protected PDFs are not supported.'
		});
		await expect(extractor.extract(textPdfFixture(['']))).rejects.toMatchObject({
			code: 'image_only_pdf'
		});
		await expect(
			extractor.extract(textPdfFixture(Array.from({ length: 251 }, () => 'Readable page text.')))
		).rejects.toMatchObject({ code: 'too_many_pages' });
	});

	it('preserves page-separated text', async () => {
		const destroy = vi.fn();
		const module: UnpdfModule = {
			getDocumentProxy: vi.fn().mockResolvedValue({ numPages: 2, destroy }),
			extractText: vi.fn().mockResolvedValue({ totalPages: 2, text: ['Page one\n', 'Page two'] })
		};
		const result = await createUnpdfExtractor(async () => module).extract(new Uint8Array([1]));
		expect(result).toEqual({ pageCount: 2, pages: ['Page one', 'Page two'] });
		expect(module.extractText).toHaveBeenCalledWith(expect.anything(), { mergePages: false });
		expect(destroy).toHaveBeenCalledOnce();
	});

	it('rejects oversized page counts before text extraction', async () => {
		const module: UnpdfModule = {
			getDocumentProxy: vi.fn().mockResolvedValue({ numPages: 251 }),
			extractText: vi.fn()
		};
		await expect(createUnpdfExtractor(async () => module).extract(new Uint8Array([1]))).rejects.toMatchObject({
			status: 413,
			code: 'too_many_pages'
		});
		expect(module.extractText).not.toHaveBeenCalled();
	});

	it('returns user-safe errors for encrypted and image-only PDFs', async () => {
		const encrypted: UnpdfModule = {
			getDocumentProxy: vi.fn().mockRejectedValue(new Error('PasswordException: encrypted file')),
			extractText: vi.fn()
		};
		await expect(createUnpdfExtractor(async () => encrypted).extract(new Uint8Array([1]))).rejects.toMatchObject({
			code: 'encrypted_pdf',
			message: 'Password-protected PDFs are not supported.'
		});

		const scanned: UnpdfModule = {
			getDocumentProxy: vi.fn().mockResolvedValue({ numPages: 2 }),
			extractText: vi.fn().mockResolvedValue({ totalPages: 2, text: ['  ', '\n'] })
		};
		await expect(createUnpdfExtractor(async () => scanned).extract(new Uint8Array([1]))).rejects.toMatchObject({
			code: 'image_only_pdf'
		});
	});

	it('checks the PDF file signature', () => {
		expect(hasPdfSignature(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
		expect(hasPdfSignature(new TextEncoder().encode('not a pdf'))).toBe(false);
	});

	it('loads the parser before advertising document capability', async () => {
		await expect(createUnpdfExtractor().verifyCapability?.()).resolves.toBeUndefined();
		await expect(
			createUnpdfExtractor(async () => ({}) as UnpdfModule).verifyCapability?.()
		).rejects.toMatchObject({ code: 'pdf_parser_unavailable' });
	});
});

function textPdfFixture(pageTexts: string[]): Uint8Array {
	const objects: string[] = [];
	const pageRefs = pageTexts.map((_, index) => `${4 + index * 2} 0 R`).join(' ');
	objects.push('<< /Type /Catalog /Pages 2 0 R >>');
	objects.push(`<< /Type /Pages /Kids [${pageRefs}] /Count ${pageTexts.length} >>`);
	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	for (const [index, text] of pageTexts.entries()) {
		const contentId = 5 + index * 2;
		const escaped = text.replace(/([\\()])/g, '\\$1');
		const content = escaped ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : 'q Q';
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
		);
		objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	}

	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(new TextEncoder().encode(pdf).length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = new TextEncoder().encode(pdf).length;
	pdf += `xref\n0 ${objects.length + 1}\n`;
	pdf += '0000000000 65535 f \n';
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return new TextEncoder().encode(pdf);
}

function encryptedPdfFixture(): Uint8Array {
	const base64 = [
		'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDI0ZjdiNzEyZGY+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA2MTIgNzkyIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8MGU1MjI5MjVhM2U0ZTg3NGMzY2ZhY2JlZjUxMWE3M2FjNGVjMmJkODY1ZGNkM2Q0NjI3NjE0OTE3YWJmZDdlND4KL1UgPDAxODBmY2VkMTZhNjA0MjJmNDJjNDhhNTMzZjMzYjRlMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwIG4gCjAwMDAwMDAxMTggMDAwMDAgbiAKMDAwMDAwMDE2NyAwMDAwMCBuIAowMDAwMDAwMjYxIDAwMDAwIG4gCnRyYWlsZXIKPDwKL1NpemUgNgovUm9vdCAzIDAgUgovSW5mbyAxIDAgUgovSUQgWyA8MzU2MTMxMzI2MjM3NjQzNzM4MzU2MTM2NjQzNTM1MzczNTM2Mzk2MjYyMzczMDY0MzIzNDMyMzI2MTM3MzAzOT4gPDM1NjEzMTMyNjIzNzY0MzczODM1NjEzNjY0MzUzNTM3MzUzNjM5NjI2MjM3MzA2NDMyMzQzMjMyNjEzNzMwMzk+IF0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4cmVmCjQ3NgolJUVPRgo='
	].join('');
	return new Uint8Array(Buffer.from(base64, 'base64'));
}
