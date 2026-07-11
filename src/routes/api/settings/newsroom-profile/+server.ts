import { error, json, type RequestHandler } from '@sveltejs/kit';
import { ensureDefaultOrganizationForAccount } from '$lib/server/db';
import { getNewsroomProfile, upsertNewsroomProfile } from '$lib/server/documents/profiles';
import { DocumentError } from '$lib/server/documents/errors';

const DEFAULT_PROFILE = {
	timezone: 'America/Toronto',
	homeMarket: '',
	preferredDomains: [] as string[]
};

function publicProfile(profile: typeof DEFAULT_PROFILE) {
	return {
		timezone: profile.timezone,
		homeMarket: profile.homeMarket,
		preferredDomains: profile.preferredDomains
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	try {
		const orgId = await ensureDefaultOrganizationForAccount(locals.user.id);
		const profile = await getNewsroomProfile(orgId);
		return json(
			{
				profile: profile ? publicProfile(profile) : DEFAULT_PROFILE
			},
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		throw error(503, 'Newsroom context is unavailable right now.');
	}
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid profile');
	}
	const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	try {
		const orgId = await ensureDefaultOrganizationForAccount(locals.user.id);
		const profile = await upsertNewsroomProfile(orgId, {
			timezone: value.timezone,
			homeMarket: value.homeMarket,
			preferredDomains: value.preferredDomains
		});
		return json({ profile: publicProfile(profile) }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		if (cause instanceof DocumentError) throw error(cause.status, cause.message);
		throw error(503, 'Newsroom context could not be saved right now.');
	}
};
