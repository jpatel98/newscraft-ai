import { error } from '@sveltejs/kit';
import { DocumentError } from './errors';

export function throwDocumentHttpError(cause: unknown): never {
	if (cause instanceof DocumentError) throw error(cause.status, cause.message);
	throw error(500, 'The PDF request could not be completed.');
}
