import { describe, expect, it } from 'vitest';
import { buildNewsroomContext } from './newsroom-context';
import { mergeRecentlyCoveredSubjects } from './recently-covered';
import type { NewsroomProfileRow } from './types';

const profile: NewsroomProfileRow = {
	orgId: 'org-1',
	timezone: 'America/Toronto',
	homeMarket: 'Toronto',
	preferredDomains: ['cbc.ca'],
	showName: 'CityNews at Six',
	airTimeLocal: '18:00',
	audience: 'GTA general',
	beats: ['transit', 'courts'],
	styleNotes: 'Numbers as words under ten.',
	recentlyCovered: [{ subject: 'Subway strike', coveredAt: 2000 }],
	createdAt: 1,
	updatedAt: 1
};

describe('mergeRecentlyCoveredSubjects', () => {
	it('merges manual subjects and thread titles newest first without duplicates', () => {
		expect(
			mergeRecentlyCoveredSubjects(
				[
					{ subject: 'Subway strike', coveredAt: 2000 },
					{ subject: 'Old manual', coveredAt: 500 }
				],
				[
					{ title: 'Water main break', updatedAt: 3000 },
					{ title: 'subway STRIKE', updatedAt: 1000 },
					{ title: 'New conversation', updatedAt: 2500 },
					{ title: '   ', updatedAt: 2600 },
					{ title: 'Council vote', updatedAt: 1500 }
				]
			)
		).toEqual(['Water main break', 'Subway strike', 'Council vote', 'Old manual']);
	});

	it('caps at 30, dropping the oldest', () => {
		const threads = Array.from({ length: 40 }, (_, i) => ({ title: `Story ${i}`, updatedAt: i + 1 }));
		const merged = mergeRecentlyCoveredSubjects(
			[{ subject: 'Manual', coveredAt: 0 }],
			threads
		);
		expect(merged).toHaveLength(30);
		expect(merged[0]).toBe('Story 39');
		expect(merged[29]).toBe('Story 10');
		expect(merged).not.toContain('Manual');
	});
});

describe('buildNewsroomContext', () => {
	it('carries show memory and merged recently covered subjects', () => {
		expect(buildNewsroomContext(profile, [{ title: 'Water main break', updatedAt: 3000 }])).toEqual({
			timezone: 'America/Toronto',
			homeMarket: 'Toronto',
			preferredDomains: ['cbc.ca'],
			showName: 'CityNews at Six',
			airTimeLocal: '18:00',
			audience: 'GTA general',
			beats: ['transit', 'courts'],
			styleNotes: 'Numbers as words under ten.',
			recentlyCovered: ['Water main break', 'Subway strike']
		});
	});

	it('omits empty show memory and still reports recent threads without a saved profile', () => {
		expect(
			buildNewsroomContext(
				{ ...profile, showName: '', airTimeLocal: '', audience: '', beats: [], styleNotes: '', recentlyCovered: [] },
				[]
			)
		).toEqual({ timezone: 'America/Toronto', homeMarket: 'Toronto', preferredDomains: ['cbc.ca'] });
		expect(buildNewsroomContext(undefined, [{ title: 'Council vote', updatedAt: 1 }])).toEqual({
			timezone: 'America/Toronto',
			recentlyCovered: ['Council vote']
		});
	});
});
