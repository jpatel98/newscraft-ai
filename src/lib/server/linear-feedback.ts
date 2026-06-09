import { env } from '$env/dynamic/private';

export interface LinearFeedbackIssue {
	id: string;
	identifier: string;
	url: string;
}

interface CreateLinearFeedbackIssueInput {
	feedbackId: string;
	conversationId: string;
	comment: string;
	messageCount: number;
	diagnosticCount: number;
	createdAt: number;
}

interface LinearIssueCreateResponse {
	data?: {
		issueCreate?: {
			success?: boolean;
			issue?: LinearFeedbackIssue;
		};
	};
	errors?: Array<{ message?: string }>;
}

export function linearFeedbackConfigured(): boolean {
	return Boolean(env.LINEAR_API_KEY && env.LINEAR_FEEDBACK_TEAM_ID);
}

export async function createLinearFeedbackIssue(
	input: CreateLinearFeedbackIssueInput
): Promise<LinearFeedbackIssue | null> {
	if (!linearFeedbackConfigured()) return null;
	const apiKey = env.LINEAR_API_KEY as string;
	const labelIds = csv(env.LINEAR_FEEDBACK_LABEL_IDS);
	const issueInput: Record<string, unknown> = {
		teamId: env.LINEAR_FEEDBACK_TEAM_ID,
		title: feedbackTitle(input.comment),
		description: feedbackDescription(input),
		priority: 3
	};
	if (env.LINEAR_FEEDBACK_PROJECT_ID) issueInput.projectId = env.LINEAR_FEEDBACK_PROJECT_ID;
	if (labelIds.length) issueInput.labelIds = labelIds;

	const response = await fetch('https://api.linear.app/graphql', {
		method: 'POST',
		headers: {
			authorization: apiKey,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			query: `
				mutation CreateNewsCraftFeedback($input: IssueCreateInput!) {
					issueCreate(input: $input) {
						success
						issue {
							id
							identifier
							url
						}
					}
				}
			`,
			variables: { input: issueInput }
		})
	});
	const json = (await response.json().catch(() => ({}))) as LinearIssueCreateResponse;
	if (!response.ok || json.errors?.length) {
		throw new Error(json.errors?.map((err) => err.message).filter(Boolean).join('; ') || `Linear ${response.status}`);
	}
	const issue = json.data?.issueCreate?.issue;
	if (!json.data?.issueCreate?.success || !issue) throw new Error('Linear issueCreate did not return an issue');
	return issue;
}

function feedbackTitle(comment: string): string {
	const compact = comment.replace(/\s+/g, ' ').trim();
	return `[Feedback] ${compact.length > 80 ? `${compact.slice(0, 77)}...` : compact}`;
}

function feedbackDescription(input: CreateLinearFeedbackIssueInput): string {
	const link = conversationLink(input.conversationId);
	return [
		'## User feedback',
		input.comment,
		'',
		'## Captured context',
		`- Feedback ID: ${input.feedbackId}`,
		`- Conversation ID: ${input.conversationId}`,
		link ? `- Conversation: ${link}` : null,
		`- Messages captured: ${input.messageCount}`,
		`- Diagnostic events captured: ${input.diagnosticCount}`,
		`- Captured at: ${new Date(input.createdAt).toISOString()}`,
		'',
		'The full chat snapshot and sanitized diagnostics are stored in NewsCraft `chat_feedback`.'
	]
		.filter(Boolean)
		.join('\n');
}

function conversationLink(conversationId: string): string | null {
	const base = (env.LINEAR_FEEDBACK_APP_URL || env.ORIGIN || '').replace(/\/$/, '');
	return base ? `${base}/c/${conversationId}` : null;
}

function csv(value: string | undefined): string[] {
	return (value || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}
