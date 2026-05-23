import { error, json, type RequestHandler } from '@sveltejs/kit';
import { eq, like } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	conversations,
	agentChannelConfigs,
	agentChannelPosts,
	missionReports,
	missions,
	settings
} from '$lib/server/db/schema';

interface Body {
	confirm?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const accountId = locals.user.id;

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	if (body.confirm !== 'WIPE-EVERYTHING') {
		throw error(400, 'confirmation phrase missing or incorrect');
	}

	await db.transaction(async (tx: any) => {
		await tx.delete(missionReports).where(eq(missionReports.accountId, accountId));
		await tx.delete(missions).where(eq(missions.accountId, accountId));
		await tx.delete(agentChannelConfigs).where(eq(agentChannelConfigs.accountId, accountId));
		await tx.delete(agentChannelPosts).where(eq(agentChannelPosts.accountId, accountId));
		await tx.delete(conversations).where(eq(conversations.accountId, accountId));
		await tx.delete(settings)
			.where(like(settings.key, `agent.hidden_channel_job_ids.${accountId}`));
	});

	return json({ ok: true });
};
