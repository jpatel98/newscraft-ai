import { error, json, type RequestHandler } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	conversations,
	hermesChannelConfigs,
	hermesChannelPosts,
	hermesChannelSources,
	messages,
	missionReports,
	missionRuns,
	missions,
	missionSources,
	settings
} from '$lib/server/db/schema';

interface Body {
	confirm?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	if (body.confirm !== 'WIPE-EVERYTHING') {
		throw error(400, 'confirmation phrase missing or incorrect');
	}

	db.transaction((tx) => {
		tx.delete(missionReports).run();
		tx.delete(missionRuns).run();
		tx.delete(missionSources).run();
		tx.delete(missions).run();
		tx.delete(hermesChannelSources).run();
		tx.delete(hermesChannelConfigs).run();
		tx.delete(hermesChannelPosts).run();
		tx.delete(messages).run();
		tx.delete(conversations).run();
		tx.delete(settings).where(eq(settings.key, 'hermes.hidden_channel_job_ids')).run();
	});

	return json({ ok: true });
};
