import { describe, expect, it } from 'vitest';
import { formatNewsroomToday } from './newsroom-today';

describe('formatNewsroomToday', () => {
	it('formats the date in the newsroom timezone with a generic zone abbreviation', () => {
		expect(formatNewsroomToday('America/Toronto', new Date('2026-10-11T03:05:00Z'))).toBe(
			'Saturday, October 10, 2026, 11:05 p.m. ET'
		);
		expect(formatNewsroomToday('America/Toronto', new Date('2026-01-15T14:30:00Z'))).toBe(
			'Thursday, January 15, 2026, 9:30 a.m. ET'
		);
	});

	it('falls back to Toronto for an invalid timezone', () => {
		expect(formatNewsroomToday('Not/AZone', new Date('2026-10-11T03:05:00Z'))).toContain('2026');
	});
});
