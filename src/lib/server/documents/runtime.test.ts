import { describe, expect, it, vi } from 'vitest';
import { DocumentError } from './errors';
import { ignoreOnlyMissingDocumentTables, isMissingDocumentTablesError } from './runtime';

function postgresError(code: string, message: string, table?: string) {
	return Object.assign(new Error(message), { code, table_name: table });
}

describe('document cleanup mixed-deployment handling', () => {
	it('treats only an explicitly missing document table as a no-op', async () => {
		const missingDocuments = postgresError(
			'42P01',
			'relation "conversation_documents" does not exist',
			'conversation_documents'
		);
		expect(isMissingDocumentTablesError(missingDocuments)).toBe(true);
		await expect(
			ignoreOnlyMissingDocumentTables(async () => {
				throw missingDocuments;
			})
		).resolves.toBeUndefined();
	});

	it('recognizes a missing document table through a wrapped database error', () => {
		const cause = postgresError(
			'42P01',
			'relation "conversation_document_pages" does not exist'
		);
		expect(isMissingDocumentTablesError(Object.assign(new Error('query failed'), { cause }))).toBe(true);
	});

	it('propagates unrelated missing-table and storage deletion failures', async () => {
		const missingAccounts = postgresError('42P01', 'relation "accounts" does not exist', 'accounts');
		const storageFailure = new DocumentError(
			503,
			'document_storage_unavailable',
			'PDF storage is unavailable right now.'
		);

		for (const failure of [missingAccounts, storageFailure]) {
			const operation = vi.fn().mockRejectedValue(failure);
			await expect(ignoreOnlyMissingDocumentTables(operation)).rejects.toBe(failure);
			expect(operation).toHaveBeenCalledOnce();
		}
	});
});
