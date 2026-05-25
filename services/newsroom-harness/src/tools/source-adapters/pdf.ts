import type { SourceAdapter, SourceAdapterExtractInput, SourceItem } from './types.js';
import { adapterFetch, cleanText, defaultDiff, sourceItem, sourceTitleFromUrl } from './utils.js';

export const pdfAdapter: SourceAdapter = {
	kind: 'pdf',
	canHandle({ url, contentType, body }) {
		return Boolean(contentType?.includes('pdf') || /\.pdf(?:$|[?#])/i.test(url) || (body ?? '').startsWith('%PDF'));
	},
	fetch: adapterFetch,
	discover: extractPdfText,
	extract: extractPdfText,
	diff: defaultDiff
};

function extractPdfText(input: SourceAdapterExtractInput): SourceItem[] {
	const text = cleanText(
		[
			...literalTextRuns(input.body),
			...arrayTextRuns(input.body),
			...metadataText(input.body)
		].join(' ')
	);
	const title = metadataValue(input.body, 'Title') || sourceTitleFromUrl(input.url);
	return [
		sourceItem('pdf', input, {
			url: input.url,
			title,
			summary: text.slice(0, 360),
			contentText: text || title
		})
	];
}

function literalTextRuns(body: string): string[] {
	return [...body.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g)].map((match) => decodePdfText(match[1]));
}

function arrayTextRuns(body: string): string[] {
	return [...body.matchAll(/\[((?:\s*\([^()]*(?:\\.[^()]*)*\)\s*)+)\]\s*TJ/g)].map((match) =>
		[...match[1].matchAll(/\(([^()]*(?:\\.[^()]*)*)\)/g)].map((part) => decodePdfText(part[1])).join('')
	);
}

function metadataText(body: string): string[] {
	return ['Title', 'Subject', 'Keywords'].flatMap((key) => {
		const value = metadataValue(body, key);
		return value ? [value] : [];
	});
}

function metadataValue(body: string, key: string): string | null {
	const match = body.match(new RegExp(`/${key}\\s*\\(([^()]*(?:\\\\.[^()]*)*)\\)`));
	return match ? decodePdfText(match[1]) : null;
}

function decodePdfText(value: string): string {
	return value
		.replace(/\\n/g, '\n')
		.replace(/\\r/g, '\r')
		.replace(/\\t/g, '\t')
		.replace(/\\([()\\])/g, '$1')
		.replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
