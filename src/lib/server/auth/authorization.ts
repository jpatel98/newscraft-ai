import { error } from '@sveltejs/kit';

export function isAdmin(user: App.Locals['user']): boolean {
	return user?.role === 'admin';
}

export function requireAdmin(user: App.Locals['user']): asserts user is NonNullable<App.Locals['user']> {
	if (!user) throw error(401, 'unauthorized');
	if (!isAdmin(user)) throw error(403, 'admin access required');
}
