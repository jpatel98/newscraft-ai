import { error, json, type RequestHandler } from '@sveltejs/kit';
import { eq, like } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	conversations,
	hermesChannelConfigs,
	hermesChannelPosts,
	hermesChannelSources,
	messages,
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

	db.transaction((tx: any) => {
		tx.delete(missionReports).where(eq(missionReports.accountId, accountId)).run();
		tx.delete(missions).where(eq(missions.accountId, accountId)).run();
		tx.delete(hermesChannelConfigs).where(eq(hermesChannelConfigs.accountId, accountId)).run();
		tx.delete(hermesChannelPosts).where(eq(hermesChannelPosts.accountId, accountId)).run();
		tx.delete(conversations).where(eq(conversations.accountId, accountId)).run();
		tx.delete(settings)
			.where(like(settings.key, `hermes.hidden_channel_job_ids.${accountId}`))
			.run();
	});

	return json({ ok: true });
};
