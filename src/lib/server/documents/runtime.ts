import { createUnpdfExtractor } from './pdf';
import { createPostgresDocumentRepository } from './repository';
import { ConversationDocumentService } from './service';
import { createSupabaseDocumentStorage } from './storage';

let service: ConversationDocumentService | undefined;

export function getConversationDocumentService(): ConversationDocumentService {
	service ??= new ConversationDocumentService(
		createPostgresDocumentRepository(),
		createSupabaseDocumentStorage(),
		createUnpdfExtractor()
	);
	return service;
}

export async function cleanupConversationDocumentObjects(
	accountId: string,
	conversationId: string
): Promise<void> {
	await ignoreOnlyMissingDocumentTables(() =>
		getConversationDocumentService().cleanupConversation(accountId, conversationId)
	);
}

export async function cleanupAccountDocumentObjects(accountId: string): Promise<void> {
	await ignoreOnlyMissingDocumentTables(() => getConversationDocumentService().cleanupAccount(accountId));
}

export async function ignoreOnlyMissingDocumentTables(operation: () => Promise<void>): Promise<void> {
	try {
		await operation();
	} catch (error) {
		if (isMissingDocumentTablesError(error)) return;
		throw error;
	}
}

export function isMissingDocumentTablesError(error: unknown): boolean {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current);
		const record = current as Record<string, unknown>;
		const code = typeof record.code === 'string' ? record.code : '';
		const table =
			typeof record.table_name === 'string'
				? record.table_name
				: typeof record.table === 'string'
					? record.table
					: '';
		const message =
			current instanceof Error
				? current.message
				: typeof record.message === 'string'
					? record.message
					: '';
		if (
			code === '42P01' &&
			(isDocumentTableName(table) || /\bconversation_document(?:s|_pages)\b/.test(message))
		) {
			return true;
		}
		current = record.cause;
	}
	return false;
}

function isDocumentTableName(value: string): boolean {
	return value === 'conversation_documents' || value === 'conversation_document_pages';
}
