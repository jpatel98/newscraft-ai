import { describe, expect, it } from 'vitest';
import { outletLabel, shortSourceDateLabel, sortNewestFirst } from './source-labels';

describe('source labels', () => {
	it('names known outlets and falls back to the bare host', () => {
		expect(outletLabel('cbc.ca')).toBe('CBC News');
		expect(outletLabel('www.cbc.ca')).toBe('CBC News');
		expect(outletLabel('toronto.citynews.ca')).toBe('CityNews');
		expect(outletLabel('https://www.thestar.com/news/gta')).toBe('Toronto Star');
		expect(outletLabel('www.example-local.ca')).toBe('example-local.ca');
		expect(outletLabel('Attached document')).toBe('Attached document');
	});

	it('writes short publish dates, adding the year only when it differs', () => {
		const now = new Date(2026, 9, 15);
		expect(shortSourceDateLabel('2026-10-12', now)).toBe('Oct 12');
		expect(shortSourceDateLabel('2025-03-04', now)).toBe('Mar 4, 2025');
		expect(shortSourceDateLabel(null, now)).toBe('Date unknown');
	});

	it('sorts newest first and keeps undated sources last in their original order', () => {
		const sorted = sortNewestFirst([
			{ id: 'a', publicationDate: null },
			{ id: 'b', publicationDate: '2026-10-10' },
			{ id: 'c', publicationDate: '2026-10-12T14:00:00Z' },
			{ id: 'd', publicationDate: 'not a date' },
			{ id: 'e', publicationDate: '2026-10-11' }
		]);
		expect(sorted.map((item) => item.id)).toEqual(['c', 'e', 'b', 'a', 'd']);
	});
});
