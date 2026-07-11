import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./Composer.svelte', import.meta.url), 'utf8');

describe('Composer failure preservation', () => {
	it('restores draft text and attachments when delegated send fails', () => {
		expect(source).toContain("const SEND_FAILURE_MESSAGE = \"Couldn't send. Your draft is still here.\";");
		expect(source).toContain('function snapshotAttachments(): Attachment[]');
		expect(source).toContain('const sentValue = value;');
		expect(source).toContain('const sentAttachments = snapshotAttachments();');
		expect(source).toContain('const sentDocuments = snapshotDocuments();');
		expect(source).toContain('attachments = sentAttachments;');
		expect(source).toContain('documentAttachments = sentDocuments;');
		expect(source).toContain('const sentDocumentIds = readyDocumentIds(sentDocuments);');
		expect(source).toContain('onSend(content, command, sentDocumentIds)');
		expect(source).toContain('restoreFailedSend(sentValue, sentAttachments, sentDocuments);');
		expect(source).not.toContain('void onSend(content, command);');
	});

	it('gates PDF controls and blocks send until every attached document is ready', () => {
		expect(source).toContain("documentsEnabled = false");
		expect(source).toContain("accept={documentsEnabled ? 'image/*,application/pdf,.pdf' : 'image/*'}");
		expect(source).toContain("document.state === 'uploading' || document.state === 'processing'");
		expect(source).toContain(
			"documentAttachments.some((document) => document.state !== 'ready')"
		);
		expect(source).toContain('pdfSelectionError(pdfs, documentAttachments.length)');
		expect(source).toContain('PDF_UPLOAD_FAILURE_MESSAGE');
	});

	it('does not clear create-conversation drafts before navigation succeeds', () => {
		const createStart = source.indexOf("const r = await fetch('/api/conversations'");
		const firstValueClear = source.indexOf("value = '';", createStart);
		const firstAttachmentClear = source.indexOf('attachments = [];', createStart);
		const firstGoto = source.indexOf('await goto', createStart);

		expect(source).toContain(
			"const CREATE_FAILURE_MESSAGE = \"Couldn't start a new chat. Your draft is still here.\";"
		);
		expect(source).not.toContain('create-conv ${r.status}');
		expect(createStart).toBeGreaterThan(-1);
		expect(firstGoto).toBeGreaterThan(createStart);
		expect(firstValueClear).toBeGreaterThan(firstGoto);
		expect(firstAttachmentClear).toBeGreaterThan(firstGoto);
	});
});
