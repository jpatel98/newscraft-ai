import { MAX_PDF_PAGES } from './constants';
import { DocumentError } from './errors';
import type { PdfExtractor } from './types';
import { extractText, getDocumentProxy } from 'unpdf';

interface UnpdfDocumentProxy {
	numPages: number;
	destroy?: () => void | Promise<void>;
}

export interface UnpdfModule {
	getDocumentProxy(data: Uint8Array): Promise<UnpdfDocumentProxy>;
	extractText(
		pdf: UnpdfDocumentProxy,
		options: { mergePages: false }
	): Promise<{ totalPages: number; text: string[] | string }>;
}

type UnpdfLoader = () => Promise<UnpdfModule>;

async function loadUnpdf(): Promise<UnpdfModule> {
	return { extractText, getDocumentProxy } as unknown as UnpdfModule;
}

export function createUnpdfExtractor(loader: UnpdfLoader = loadUnpdf): PdfExtractor {
	return {
		async verifyCapability() {
			const unpdf = await loader();
			if (typeof unpdf.getDocumentProxy !== 'function' || typeof unpdf.extractText !== 'function') {
				throw new DocumentError(503, 'pdf_parser_unavailable', 'PDF processing is unavailable right now.');
			}
		},
		async extract(bytes) {
			let pdf: UnpdfDocumentProxy | undefined;
			try {
				const unpdf = await loader();
				pdf = await unpdf.getDocumentProxy(bytes);
				if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) {
					throw new DocumentError(422, 'unreadable_pdf', 'NewsCraft could not read this PDF.');
				}
				if (pdf.numPages > MAX_PDF_PAGES) {
					throw new DocumentError(413, 'too_many_pages', 'PDFs must contain 250 pages or fewer.');
				}
				const extracted = await unpdf.extractText(pdf, { mergePages: false });
				const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
				const normalized = Array.from({ length: pdf.numPages }, (_, index) =>
					normalizePageText(pages[index] ?? '')
				);
				if (!normalized.some(hasMeaningfulText)) {
					throw new DocumentError(
						422,
						'image_only_pdf',
						'This PDF has no readable text. Scanned PDFs are not supported yet.'
					);
				}
				return { pageCount: pdf.numPages, pages: normalized };
			} catch (error) {
				if (error instanceof DocumentError) throw error;
				if (looksEncrypted(error)) {
					throw new DocumentError(
						422,
						'encrypted_pdf',
						'Password-protected PDFs are not supported.'
					);
				}
				throw new DocumentError(422, 'unreadable_pdf', 'NewsCraft could not read this PDF.');
			} finally {
				await pdf?.destroy?.();
			}
		}
	};
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 5 &&
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46 &&
		bytes[4] === 0x2d
	);
}

function normalizePageText(value: string): string {
	return value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function hasMeaningfulText(value: string): boolean {
	return /[\p{L}\p{N}]/u.test(value);
}

function looksEncrypted(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return /password|encrypted|encryption|PasswordException/i.test(message);
}
