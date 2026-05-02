import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	const next = new URL('/mission-control', url.origin);
	for (const [key, value] of url.searchParams) {
		next.searchParams.set(key === 'post' ? 'report' : key, value);
	}
	throw redirect(307, `${next.pathname}${next.search}`);
};
