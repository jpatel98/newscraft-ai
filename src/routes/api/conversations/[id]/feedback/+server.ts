import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation, getMessages } from '$lib/server/db/conversations';
import { attachLinearIssueToFeedback, saveChatFeedback } from '$lib/server/db/feedback';
import { recentChatDiagnostics, recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import { createLinearFeedbackIssue } from '$lib/server/linear-feedback';

const MAX_COMMENT_CHARS = 4000;

export const POST: RequestHandler = async ({ request, locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: { comment?: unknown };
	try {
		body = (await request.json()) as { comment?: unknown };
	} catch {
		throw error(400, 'invalid json');
	}

	const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
	if (!comment) throw error(400, 'comment required');
	if (comment.length > MAX_COMMENT_CHARS) throw error(413, 'comment too long');

	if (!params.id) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');

	const messages = await getMessages(conversation.id);
	const capturedAt = Date.now();
	recordChatDiagnostic(conversation.id, 'feedback.capture.request', {
		messageCount: messages.length,
		commentChars: comment.length
	});
	const diagnostics = recentChatDiagnostics(conversation.id);
	const feedback = await saveChatFeedback({
		accountId: locals.user.id,
		conversationId: conversation.id,
		comment,
		userAgent: request.headers.get('user-agent'),
		snapshot: {
			conversation: {
				id: conversation.id,
				title: conversation.title,
				systemPrompt: conversation.systemPrompt,
				createdAt: conversation.createdAt,
				updatedAt: conversation.updatedAt
			},
			messages: messages.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				toolCalls: message.toolCalls,
				partial: message.partial,
				createdAt: message.createdAt
			})),
			diagnostics,
			capturedAt,
			messageCount: messages.length
		}
	});
	let linearIssue:
		| {
				id: string;
				identifier: string;
				url: string;
		  }
		| null = null;
	let linearError: string | null = null;
	try {
		linearIssue = await createLinearFeedbackIssue({
			feedbackId: feedback.id,
			conversationId: conversation.id,
			comment,
			messageCount: messages.length,
			diagnosticCount: diagnostics.length,
			createdAt: feedback.createdAt
		});
		if (linearIssue) {
			await attachLinearIssueToFeedback({
				feedbackId: feedback.id,
				linearIssueId: linearIssue.id,
				linearIssueIdentifier: linearIssue.identifier,
				linearIssueUrl: linearIssue.url
			});
			recordChatDiagnostic(conversation.id, 'feedback.linear.created', {
				identifier: linearIssue.identifier,
				url: linearIssue.url
			});
		} else {
			recordChatDiagnostic(conversation.id, 'feedback.linear.skipped', {
				reason: 'not_configured'
			});
		}
	} catch (err) {
		linearError = err instanceof Error ? err.message : String(err);
		recordChatDiagnostic(conversation.id, 'feedback.linear.error', {
			error: linearError
		});
	}

	return json({
		id: feedback.id,
		conversationId: feedback.conversationId,
		messageCount: messages.length,
		linearIssue,
		linearError,
		createdAt: feedback.createdAt
	});
};
