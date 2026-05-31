import type { NewsroomEventDto } from '@newscraft/shared';
import type { HarnessConfig } from '../config.js';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { nowIso } from '../util/ids.js';
import {
	publishGateAllowsDelivery,
	requireStoryPackage,
	type StoryPackage
} from './packager.js';

export type DeliveryChannel = 'email_digest' | 'webhook' | 'slack' | 'wordpress';
export type DeliveryStatus = 'prepared' | 'sent' | 'failed';

export interface DeliveryInput {
	storyId: string;
	packageId: string;
	channel: DeliveryChannel;
	workspaceId?: string;
	jobId?: string | null;
	runId?: string | null;
	actor?: string;
	targetUrl?: string | null;
	wordpressPostId?: string | number | null;
}

export interface DeliveryRunResult {
	ok: boolean;
	status: DeliveryStatus;
	channel: DeliveryChannel;
	package_id: string;
	story_id: string;
	target_host: string | null;
	response_status: number | null;
	external_id: string | null;
	event: NewsroomEventDto;
	error?: string;
}

interface DeliveryAttempt {
	status: DeliveryStatus;
	targetHost: string | null;
	responseStatus: number | null;
	externalId: string | null;
	error?: string;
}

export class DeliveryPreconditionError extends Error {}

export async function deliverPackage(
	repository: HarnessRepository,
	config: HarnessConfig,
	input: DeliveryInput
): Promise<DeliveryRunResult> {
	const storyId = requiredText(input.storyId, 'story_id');
	const packageId = requiredText(input.packageId, 'package_id');
	const channel = requiredChannel(input.channel);
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const actor = input.actor?.trim() || 'delivery';
	const pkg = requireStoryPackage(repository, storyId, packageId, workspaceId);
	const publishGate = publishGateAllowsDelivery(repository, { storyId, workspaceId, packageId });

	if (!publishGate) {
		return recordDelivery(repository, {
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			actor,
			channel,
			pkg,
			attempt: {
				status: 'failed',
				targetHost: null,
				responseStatus: null,
				externalId: null,
				error: 'Delivery requires a resolved Publish gate with approve or send_to_cms.'
			}
		});
	}

	let attempt: DeliveryAttempt;
	try {
		attempt = await runDeliveryAttempt(config, pkg, input);
	} catch (err) {
		attempt = {
			status: 'failed',
			targetHost: targetHostForFailure(config, input),
			responseStatus: null,
			externalId: null,
			error: publicError(err)
		};
	}

	return recordDelivery(repository, {
		workspaceId,
		storyId,
		jobId: input.jobId,
		runId: input.runId,
		actor,
		channel,
		pkg,
		attempt
	});
}

async function runDeliveryAttempt(
	config: HarnessConfig,
	pkg: StoryPackage,
	input: DeliveryInput
): Promise<DeliveryAttempt> {
	if (input.channel === 'email_digest') return sendEmailDigest(config, pkg, input);
	if (input.channel === 'webhook') return sendWebhook(config, pkg, input);
	if (input.channel === 'slack') return sendSlack(config, pkg, input);
	if (input.channel === 'wordpress') return sendWordPress(config, pkg, input);
	throw new DeliveryPreconditionError(`Unsupported delivery channel: ${input.channel}`);
}

async function sendEmailDigest(
	config: HarnessConfig,
	pkg: StoryPackage,
	input: DeliveryInput
): Promise<DeliveryAttempt> {
	const targetUrl = safeHttpUrl(input.targetUrl) || safeHttpUrl(config.emailDigestWebhookUrl);
	if (!targetUrl) {
		return {
			status: 'prepared',
			targetHost: null,
			responseStatus: null,
			externalId: null
		};
	}
	const response = await postJson(targetUrl, {
		type: 'newscraft.email_digest',
		package_id: pkg.package_id,
		subject: pkg.outputs.newsletter_blurb.subject,
		markdown: pkg.outputs.newsletter_blurb.markdown,
		brief: pkg.outputs.brief.markdown,
		headlines: pkg.outputs.headline_pack
	});
	return responseAttempt(response, targetUrl);
}

async function sendWebhook(
	config: HarnessConfig,
	pkg: StoryPackage,
	input: DeliveryInput
): Promise<DeliveryAttempt> {
	const targetUrl = safeHttpUrl(input.targetUrl) || safeHttpUrl(config.deliveryWebhookUrl);
	if (!targetUrl) throw new DeliveryPreconditionError('Webhook delivery requires NEWSROOM_DELIVERY_WEBHOOK_URL or target_url.');
	const response = await postJson(targetUrl, {
		type: 'newscraft.package',
		package_id: pkg.package_id,
		story_id: pkg.story_id,
		headline: pkg.headline,
		outputs: pkg.outputs,
		citations: pkg.citations.map(publicCitation)
	});
	return responseAttempt(response, targetUrl);
}

async function sendSlack(
	config: HarnessConfig,
	pkg: StoryPackage,
	input: DeliveryInput
): Promise<DeliveryAttempt> {
	const targetUrl = safeHttpUrl(input.targetUrl) || safeHttpUrl(config.slackWebhookUrl);
	if (!targetUrl) throw new DeliveryPreconditionError('Slack delivery requires NEWSROOM_SLACK_WEBHOOK_URL or target_url.');
	const response = await postJson(targetUrl, {
		text: `${pkg.headline}\n${pkg.outputs.brief.markdown}`,
		blocks: [
			{ type: 'header', text: { type: 'plain_text', text: trimText(pkg.headline, 150) } },
			{ type: 'section', text: { type: 'mrkdwn', text: pkg.outputs.brief.markdown } },
			{
				type: 'context',
				elements: [{ type: 'mrkdwn', text: `NewsCraft package ${pkg.package_id} passed the Publish gate.` }]
			}
		]
	});
	return responseAttempt(response, targetUrl);
}

async function sendWordPress(
	config: HarnessConfig,
	pkg: StoryPackage,
	input: DeliveryInput
): Promise<DeliveryAttempt> {
	const base = safeHttpUrl(config.wordpressRestUrl);
	if (!base || !config.wordpressUsername || !config.wordpressApplicationPassword) {
		throw new DeliveryPreconditionError(
			'WordPress delivery requires WORDPRESS_REST_URL, WORDPRESS_USERNAME, and WORDPRESS_APP_PASSWORD.'
		);
	}
	const endpoint = wordpressPostsEndpoint(base, input.wordpressPostId);
	const auth = Buffer.from(`${config.wordpressUsername}:${config.wordpressApplicationPassword}`).toString('base64');
	const response = await postJson(
		endpoint,
		{
			title: pkg.outputs.headline_pack.seo.headline || pkg.headline,
			content: pkg.outputs.web_story.markdown,
			excerpt: pkg.outputs.brief.markdown,
			status: 'draft',
			meta: {
				newscraft_package_id: pkg.package_id,
				newscraft_story_id: pkg.story_id
			}
		},
		{ authorization: `Basic ${auth}` }
	);
	return responseAttempt(response, endpoint);
}

function recordDelivery(
	repository: HarnessRepository,
	input: {
		workspaceId: string;
		storyId: string;
		jobId?: string | null;
		runId?: string | null;
		actor: string;
		channel: DeliveryChannel;
		pkg: StoryPackage;
		attempt: DeliveryAttempt;
	}
): DeliveryRunResult {
	const createdAt = nowIso();
	const payload = {
		package_id: input.pkg.package_id,
		story_id: input.storyId,
		channel: input.channel,
		status: input.attempt.status,
		target_host: input.attempt.targetHost,
		response_status: input.attempt.responseStatus,
		external_id: input.attempt.externalId,
		error: input.attempt.error ?? null
	};
	const event = repository.appendEvent({
		workspaceId: input.workspaceId,
		storyId: input.storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: input.actor,
		kind: input.attempt.status === 'failed' ? 'delivery.failed' : input.attempt.status === 'prepared' ? 'delivery.prepared' : 'delivery.sent',
		payload,
		sources: input.pkg.citations.map((citation) => ({
			url: citation.source_url,
			title: citation.source_title,
			fact_id: citation.fact_id,
			marker: citation.marker,
			archive_snapshot_url: citation.archive_snapshot_url,
			content_hash: citation.content_hash
		})),
		parentEventId: input.pkg.package_event_id,
		createdAt
	});
	repository.appendStoryMemory(input.storyId, {
		workspaceId: input.workspaceId,
		key: 'delivery_history',
		kind: event.kind,
		actor: input.actor,
		createdAt,
		value: { ...payload, event_id: event.id }
	});
	return {
		ok: input.attempt.status !== 'failed',
		status: input.attempt.status,
		channel: input.channel,
		package_id: input.pkg.package_id,
		story_id: input.storyId,
		target_host: input.attempt.targetHost,
		response_status: input.attempt.responseStatus,
		external_id: input.attempt.externalId,
		event,
		error: input.attempt.error
	};
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...headers
		},
		body: JSON.stringify(body)
	});
}

async function responseAttempt(response: Response, targetUrl: string): Promise<DeliveryAttempt> {
	let responseBody: unknown = null;
	try {
		responseBody = await response.json();
	} catch {
		responseBody = null;
	}
	const id = externalId(responseBody);
	if (!response.ok) {
		return {
			status: 'failed',
			targetHost: sourceHost(targetUrl),
			responseStatus: response.status,
			externalId: id,
			error: `Delivery target returned HTTP ${response.status}`
		};
	}
	return {
		status: 'sent',
		targetHost: sourceHost(targetUrl),
		responseStatus: response.status,
		externalId: id
	};
}

function wordpressPostsEndpoint(base: string, postId?: string | number | null): string {
	const url = new URL(base);
	const normalizedPath = url.pathname.replace(/\/+$/, '');
	const apiPath = normalizedPath.endsWith('/wp/v2') ? normalizedPath : `${normalizedPath}/wp/v2`;
	url.pathname = `${apiPath}/posts${postId ? `/${encodeURIComponent(String(postId))}` : ''}`;
	url.search = '';
	return url.toString();
}

function targetHostForFailure(config: HarnessConfig, input: DeliveryInput): string | null {
	const url =
		input.targetUrl ||
		(input.channel === 'email_digest'
			? config.emailDigestWebhookUrl
			: input.channel === 'webhook'
				? config.deliveryWebhookUrl
				: input.channel === 'slack'
					? config.slackWebhookUrl
					: config.wordpressRestUrl);
	return safeHttpUrl(url) ? sourceHost(url as string) : null;
}

function publicCitation(citation: StoryPackage['citations'][number]) {
	return {
		marker: citation.marker,
		fact_id: citation.fact_id,
		source_title: citation.source_title,
		source_name: citation.source_name,
		source_url: citation.source_url,
		archive_snapshot_url: citation.archive_snapshot_url,
		content_hash: citation.content_hash
	};
}

function externalId(value: unknown): string | null {
	const raw = objectValue(value);
	return stringValue(raw?.id) || stringValue(raw?.external_id) || stringValue(raw?.url) || null;
}

function requiredChannel(value: string): DeliveryChannel {
	if (value === 'email_digest' || value === 'webhook' || value === 'slack' || value === 'wordpress') return value;
	throw new DeliveryPreconditionError(`Unsupported delivery channel: ${value}`);
}

function requiredText(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new DeliveryPreconditionError(`${label} is required`);
	return trimmed;
}

function trimText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function sourceHost(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value;
	}
}

function safeHttpUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

function publicError(err: unknown): string {
	if (err instanceof DeliveryPreconditionError) return err.message;
	if (err instanceof Error) return err.message.replace(/https?:\/\/\S+/g, '[redacted-url]');
	return String(err).replace(/https?:\/\/\S+/g, '[redacted-url]');
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}
