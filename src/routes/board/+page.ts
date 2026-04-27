import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	const next = new URL('/channels', url.origin);
	const channel = url.searchParams.get('channel');
	const post = url.searchParams.get('post') ?? url.searchParams.get('report');
	if (channel) next.searchParams.set('channel', channel);
	if (post) next.searchParams.set('post', post);
	throw redirect(307, `${next.pathname}${next.search}`);
};
