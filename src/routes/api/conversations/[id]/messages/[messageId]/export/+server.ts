import { error, type RequestHandler } from '@sveltejs/kit';
import { contentText } from '$lib/types';
import { getConversation, getMessageById, parseContent } from '$lib/server/db/conversations';
import { parseToolMetadata } from '$lib/utils/tool-metadata';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import { resolvedCitationRecords } from '$lib/components/journalist-ui';

function safeFilename(value: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return slug || 'newscraft-answer';
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id;
	const messageId = params.messageId;
	if (!conversationId || !messageId) throw error(400, 'answer required');

	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const message = await getMessageById(messageId);
	if (!message || message.conversationId !== conversationId || message.role !== 'assistant') {
		throw error(404, 'answer not found');
	}

	const answer = contentText(parseContent(message.content)).trim();
	const citations = resolvedCitationRecords(
		answer,
		parseToolMetadata(message.toolCalls).citations
	);
	recordChatDiagnostic(conversationId, 'chat.output_action', {
		action: 'markdown_export',
		citationCount: citations.length
	});
	const lines = ['# NewsCraft answer', '', answer || '_No answer text._'];
	if (citations.length) {
		lines.push('', '## Citations', '');
		for (const citation of citations) {
			const date = citation.publicationDate || 'Date unknown';
			const page = citation.documentPage ? `, page ${citation.documentPage}` : '';
			const details = `${date}${page}`;
			const title = escapeMarkdownLabel(citation.title);
			lines.push(
				citation.sourceType === 'user_document'
					? `- [${citation.citationNumber}] ${title} - ${details}`
					: `- [${citation.citationNumber}] [${title}](<${citation.url}>) - ${details}`
			);
		}
	}

	return new Response(`${lines.join('\n')}\n`, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Content-Disposition': `attachment; filename="${safeFilename(conversation.title || 'newscraft-answer')}-answer.md"`,
			'Cache-Control': 'no-store'
		}
	});
};

function escapeMarkdownLabel(value: string): string {
	return value.replace(/([\\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}
