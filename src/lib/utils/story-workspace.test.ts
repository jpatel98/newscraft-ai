import { describe, expect, it } from 'vitest';
import type { ChannelSource } from '$lib/types';
import {
	createGateEvent,
	createStoryWorkspace,
	type PitchGateResolution,
	type WorkspacePitch
} from './story-workspace';

const sources: ChannelSource[] = [
	{
		id: 'source-1',
		type: 'url',
		name: 'City desk',
		url: 'https://example.com/city',
		enabled: true,
		sortOrder: 0
	}
];

const pitch: WorkspacePitch = {
	id: 'pitch-1',
	beat: 'Toronto',
	title: 'Transit board weighs late-night service cuts',
	angle: 'Riders face longer waits while the board tries to close a budget gap.',
	whyNow: 'The vote is scheduled for this week.',
	confidence: 0.82,
	confidenceLabel: 'High',
	sources,
	runTime: '2026-05-24T14:00:00.000Z',
	report: 'Candidate lead from the morning run.'
};

describe('story workspace utilities', () => {
	it('creates gate events for every pitch resolution', () => {
		const now = '2026-05-24T15:00:00.000Z';
		const resolutions: PitchGateResolution[] = ['accepted', 'held', 'spiked'];

		expect(resolutions.map((resolution) => createGateEvent(pitch, resolution, now))).toEqual([
			{
				id: `pitch-${pitch.id}-accepted-${now}`,
				kind: 'pitch-gate',
				label: 'Pitch accepted',
				detail: `${pitch.title} was accepted.`,
				at: now,
				tone: 'active'
			},
			{
				id: `pitch-${pitch.id}-held-${now}`,
				kind: 'pitch-gate',
				label: 'Pitch held',
				detail: `${pitch.title} was held.`,
				at: now,
				tone: 'neutral'
			},
			{
				id: `pitch-${pitch.id}-spiked-${now}`,
				kind: 'pitch-gate',
				label: 'Pitch spiked',
				detail: `${pitch.title} was spiked.`,
				at: now,
				tone: 'warning'
			}
		]);
	});

	it('creates an active story workspace from an accepted pitch', () => {
		const now = '2026-05-24T15:05:00.000Z';

		expect(createStoryWorkspace(pitch, now)).toEqual({
			id: 'story-pitch-1',
			pitchId: pitch.id,
			beat: pitch.beat,
			title: pitch.title,
			angle: pitch.angle,
			whyNow: pitch.whyNow,
			confidenceLabel: pitch.confidenceLabel,
			sources,
			createdAt: now,
			status: 'active',
			factLedger: [
				{
					id: `fact-${pitch.id}-angle`,
					label: 'Working angle',
					detail: pitch.angle
				},
				{
					id: `fact-${pitch.id}-why-now`,
					label: 'Why now',
					detail: pitch.whyNow
				},
				{
					id: `fact-${pitch.id}-source-source-1`,
					label: 'Source 1',
					detail: 'City desk',
					sourceName: 'City desk',
					sourceUrl: 'https://example.com/city'
				}
			],
			draft: `Draft workspace for "${pitch.title}".`,
			eventLog: [
				{
					id: `pitch-${pitch.id}-accepted-${now}`,
					kind: 'pitch-gate',
					label: 'Pitch accepted',
					detail: `${pitch.title} was accepted.`,
					at: now,
					tone: 'active'
				},
				{
					id: `workspace-${pitch.id}-created-${now}`,
					kind: 'workspace-created',
					label: 'Story workspace created',
					detail: 'Fact ledger, draft canvas, event wire, and agent activity are ready.',
					at: now,
					tone: 'active'
				}
			],
			activity: [
				{
					id: `activity-${pitch.id}-assignment-${now}`,
					kind: 'assignment-desk',
					label: 'Assignment Desk',
					detail: 'Accepted the pitch and opened the story workspace.',
					at: now,
					tone: 'active'
				},
				{
					id: `activity-${pitch.id}-research-${now}`,
					kind: 'research-desk',
					label: 'Research Desk',
					detail: '1 source attached for the first source pass.',
					at: now,
					tone: 'neutral'
				}
			]
		});
	});
});
