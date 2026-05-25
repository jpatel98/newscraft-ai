import { describe, expect, it } from 'vitest';
import { isAdmin, requireAdmin } from './authorization';

describe('admin authorization', () => {
	it('recognizes only admin users as account managers', () => {
		expect(isAdmin({ id: 'a1', email: 'admin@example.test', name: 'Admin', role: 'admin' })).toBe(true);
		expect(isAdmin({ id: 'm1', email: 'member@example.test', name: 'Member', role: 'member' })).toBe(false);
		expect(isAdmin(null)).toBe(false);
	});

	it('throws 401 for anonymous callers and 403 for members', () => {
		expect(() => requireAdmin(null)).toThrow(expect.objectContaining({ status: 401 }));
		expect(() =>
			requireAdmin({ id: 'm1', email: 'member@example.test', name: 'Member', role: 'member' })
		).toThrow(expect.objectContaining({ status: 403 }));
		expect(() =>
			requireAdmin({ id: 'a1', email: 'admin@example.test', name: 'Admin', role: 'admin' })
		).not.toThrow();
	});
});
