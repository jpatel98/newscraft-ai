export class DocumentError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'DocumentError';
	}
}

export function documentErrorFromUnknown(error: unknown): DocumentError {
	if (error instanceof DocumentError) return error;
	return new DocumentError(422, 'unreadable_pdf', 'NewsCraft could not read this PDF.');
}
