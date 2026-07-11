import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	getMessageById: vi.fn()
}));
const diagnosticMocks = vi.hoisted(() => ({ recordChatDiagnostic: vi.fn() }));

vi.mock('$lib/server/db/conversations', () => ({
	...dbMocks,
	parseContent: (value: string) => value
}));
vi.mock('$lib/server/chat-diagnostics', () => diagnosticMocks);

import { GET } from './+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };

function event(authenticated = true) {
	return {
		params: { id: 'conversation-1', messageId: 'message-1' },
		locals: { user: authenticated ? user : null }
	} as any;
}

describe('per-answer Markdown export', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dbMocks.getConversation.mockResolvedValue({ id: 'conversation-1', title: 'City budget' });
		dbMocks.getMessageById.mockResolvedValue({
			id: 'message-1',
			conversationId: 'conversation-1',
			role: 'assistant',
			content: 'The vote passed [1]. The appendix confirms the amount [3].',
			toolCalls: JSON.stringify({
				version: 1,
				tools: [],
				sources: [],
				citations: [
					{
						citationNumber: 1,
						title: 'Council minutes',
						url: 'https://city.example/minutes',
						domain: 'city.example',
						publicationDate: '2026-07-10',
						sourceType: 'official',
						supportingExcerpt: 'Council approved the motion.'
					},
					{
						citationNumber: 2,
						title: 'Unused report',
						url: 'https://news.example/report',
						domain: 'news.example',
						publicationDate: null,
						sourceType: 'news_report',
						supportingExcerpt: 'This record is not cited in the answer.'
					},
					{
						citationNumber: 3,
						title: 'budget-appendix.pdf',
						url: '/api/conversations/conversation-1/documents/doc-1/download',
						domain: 'Attached document',
						publicationDate: null,
						sourceType: 'user_document',
						supportingExcerpt: 'The approved amount is $2 million.',
						documentPage: 7
					}
				]
			})
		});
	});

	it('exports only resolved citations with dates and document pages', async () => {
		const response = await GET(event());
		const markdown = await response.text();

		expect(response.headers.get('content-type')).toContain('text/markdown');
		expect(response.headers.get('content-disposition')).toContain('city-budget-answer.md');
		expect(markdown).toContain('[1] [Council minutes](<https://city.example/minutes>) - 2026-07-10');
		expect(markdown).toContain('[3] budget-appendix.pdf - Date unknown, page 7');
		expect(markdown).not.toContain('Unused report');
		expect(diagnosticMocks.recordChatDiagnostic).toHaveBeenCalledWith(
			'conversation-1',
			'chat.output_action',
			{ action: 'markdown_export', citationCount: 2 }
		);
	});

	it('requires an authenticated owner', async () => {
		await expect(GET(event(false))).rejects.toMatchObject({ status: 401 });
		dbMocks.getConversation.mockResolvedValue(undefined);
		await expect(GET(event())).rejects.toMatchObject({ status: 404 });
	});
});
