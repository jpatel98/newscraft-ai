import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './time';

describe('time formatting', () => {
	it('renders recent past timestamps relatively', () => {
		expect(formatRelativeTime(Date.UTC(2026, 4, 25, 12, 0), Date.UTC(2026, 4, 25, 12, 0, 30))).toBe(
			'just now'
		);
		expect(formatRelativeTime(Date.UTC(2026, 4, 25, 11, 58), Date.UTC(2026, 4, 25, 12, 0))).toBe(
			'2m'
		);
	});

	it('renders future timestamps absolutely instead of pretending they are now', () => {
		const formatted = formatRelativeTime(
			Date.UTC(2026, 4, 25, 12, 30),
			Date.UTC(2026, 4, 25, 12, 0)
		);

		expect(formatted).not.toBe('just now');
		expect(formatted).toMatch(/May 25/);
		expect(formatted).toMatch(/12:30|08:30/);
	});
});
