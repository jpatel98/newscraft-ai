import { describe, expect, it } from 'vitest';
import { isValidEmail, normalizeDisplayName, normalizeEmail } from './account-input';

describe('account input normalization', () => {
	it('normalizes emails for lookup and uniqueness', () => {
		expect(normalizeEmail('  Reporter@Example.COM ')).toBe('reporter@example.com');
	});

	it('accepts normal emails and rejects malformed or oversized values', () => {
		expect(isValidEmail('reporter@example.com')).toBe(true);
		expect(isValidEmail('reporter@example')).toBe(false);
		expect(isValidEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
	});

	it('normalizes whitespace in display names without truncating them', () => {
		expect(normalizeDisplayName('  News   Producer  ')).toBe('News Producer');
	});
});
